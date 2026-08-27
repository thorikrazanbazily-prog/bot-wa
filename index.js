const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// LIST NOMOR YANG DIIZINKAN
const listBolehKick = ['6281298697777'];
const listBolehHidetag = ['6281298697777'];

// Helper Konversi Format Angka Singkat (K / M / B)
function formatShortNumber(num) {
    if (!num || isNaN(num)) return num || '0';
    let n = Number(num);
    if (n >= 1000000) {
        return (n / 1000000).toFixed(1).replace('.', ',').replace(',0', '') + ' jt';
    } else if (n >= 1000) {
        return (n / 1000).toFixed(1).replace('.', ',').replace(',0', '') + ' rb';
    }
    return n.toString();
}

// Helper Konversi Foto / Stiker Ke Stiker Ber-Watermark Exif (Memakai Sharp)
async function imageToSticker(buffer, packname = 'Bot Stiker', author = 'Bot WhatsApp') {
    const webpBuffer = await sharp(buffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toFormat('webp')
        .toBuffer();

    const tmpOutput = path.join(__dirname, `tmp_${Date.now()}.webp`);
    const tmpExif = path.join(__dirname, `tmp_${Date.now()}.exif`);
    const tmpFinal = path.join(__dirname, `tmp_final_${Date.now()}.webp`);

    fs.writeFileSync(tmpOutput, webpBuffer);

    const json = {
        'sticker-pack-id': 'Bot WhatsApp',
        'sticker-pack-name': packname,
        'sticker-pack-publisher': author,
        'emojis': ['🤖']
    };

    let exifHeader = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    let exif = Buffer.concat([exifHeader, jsonBuffer]);
    exif.writeUIntLE(jsonBuffer.length, 14, 4);
    fs.writeFileSync(tmpExif, exif);

    return new Promise((resolve) => {
        exec(`webpmux -set exif ${tmpExif} ${tmpOutput} -o ${tmpFinal}`, (err) => {
            let finalBuf;
            if (!err && fs.existsSync(tmpFinal)) {
                finalBuf = fs.readFileSync(tmpFinal);
            } else {
                finalBuf = fs.readFileSync(tmpOutput);
            }

            if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
            if (fs.existsSync(tmpExif)) fs.unlinkSync(tmpExif);
            if (fs.existsSync(tmpFinal)) fs.unlinkSync(tmpFinal);

            resolve(finalBuf);
        });
    });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\nScan QR Code di bawah menggunakan WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Menghubungkan ulang...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp berhasil terhubung!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');

            const rawSender = msg.key.participant || msg.participant || msg.key.remoteJid || '';
            const senderNumber = rawSender.split('@')[0].replace(/[^0-9]/g, '');

            const body = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || 
                         msg.message.videoMessage?.caption || '';
            
            const pesan = body.trim();
            if (!pesan.startsWith('.')) continue;

            const command = pesan.toLowerCase().split(' ')[0];
            const args = pesan.split(' ').slice(1);

            // 1. FITUR .PING
            if (command === '.ping') {
                const latency = Date.now() - (msg.messageTimestamp * 1000);
                const speed = latency < 0 ? 0 : latency;
                await sock.sendMessage(from, { text: `🏓 *Pong!*\n⚡ Kecepatan respon: *${speed} ms*` }, { quoted: msg });
            } 

            // 2. FITUR .STIKER / .S / .WM
            else if (command === '.stiker' || command === '.s' || command === '.wm') {
                try {
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const typeQuoted = quoted ? Object.keys(quoted)[0] : null;

                    const isImage = msg.message.imageMessage;
                    const isQuotedImage = typeQuoted === 'imageMessage';
                    const isSticker = msg.message.stickerMessage;
                    const isQuotedSticker = typeQuoted === 'stickerMessage';

                    if (!isImage && !isQuotedImage && !isSticker && !isQuotedSticker) {
                        await sock.sendMessage(from, { 
                            text: '⚠️ Kirim foto/stiker atau reply foto/stiker dengan perintah:\n- *.stiker*\n- *.wm NamaStiker*' 
                        }, { quoted: msg });
                        return;
                    }

                    let mediaToDownload;
                    if (isQuotedImage || isQuotedSticker) {
                        mediaToDownload = {
                            key: {
                                remoteJid: from,
                                id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                                participant: msg.message.extendedTextMessage.contextInfo.participant
                            },
                            message: quoted
                        };
                    } else {
                        mediaToDownload = msg;
                    }

                    let packname = 'Bot Stiker';
                    let author = 'Bot WhatsApp';

                    if (command === '.wm') {
                        const fullText = args.join(' ').trim();
                        if (fullText.includes('|')) {
                            const splitText = fullText.split('|');
                            packname = splitText[0].trim() || 'Bot Stiker';
                            author = splitText[1].trim() || 'Bot WhatsApp';
                        } else if (fullText) {
                            packname = fullText;
                            author = 'Bot WhatsApp';
                        }
                    }

                    const buffer = await downloadMediaMessage(mediaToDownload, 'buffer', {});
                    const stickerBuffer = await imageToSticker(buffer, packname, author);

                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
                } catch (err) {
                    console.error('Error stiker/wm:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal membuat stiker dengan watermark.' }, { quoted: msg });
                }
            }

            // 3. FITUR .HIDETAG / .H
            else if (command === '.hidetag' || command === '.h') {
                if (!isGroup) {
                    await sock.sendMessage(from, { text: '⚠️ Fitur ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    return;
                }

                const isFromMe = msg.key.fromMe;
                const punyaIzin = isFromMe || listBolehHidetag.includes(senderNumber);

                if (!punyaIzin) {
                    await sock.sendMessage(from, { text: '❌ Anda tidak memiliki izin untuk menggunakan perintah .hidetag!' }, { quoted: msg });
                    return;
                }

                try {
                    const groupMetadata = await sock.groupMetadata(from);
                    const participants = groupMetadata.participants;
                    const mentions = participants.map(mem => mem.id);

                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const teksPesan = args.join(' ').trim();

                    if (quotedMsg) {
                        await sock.sendMessage(from, { 
                            forward: { key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quotedMsg, remoteJid: from },
                            mentions: mentions
                        });
                    } else {
                        const teksKirim = teksPesan ? teksPesan : '📢 *PENGUMUMAN*';
                        await sock.sendMessage(from, { 
                            text: teksKirim, 
                            mentions: mentions 
                        }, { quoted: msg });
                    }
                } catch (err) {
                    console.error('Error hidetag:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal menjalankan perintah hidetag.' }, { quoted: msg });
                }
            }

            // 4. FITUR .LISTMEM
            else if (command === '.listmem') {
                if (!isGroup) {
                    await sock.sendMessage(from, { text: '⚠️ Fitur ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    return;
                }
                try {
                    const groupMetadata = await sock.groupMetadata(from);
                    const participants = groupMetadata.participants;

                    let teksBalas = `📋 *DAFTAR MEMBER GRUP*\n👥 Total: *${participants.length} Member*\n\n`;
                    let mentions = [];

                    for (let mem of participants) {
                        teksBalas += `@${mem.id.split('@')[0]}\n`;
                        mentions.push(mem.id);
                    }

                    await sock.sendMessage(from, { text: teksBalas, mentions: mentions }, { quoted: msg });
                } catch (err) {
                    console.error('Error listmem:', err);
                }
            }

            // 5. FITUR .VERIF TIKTOK (MULTI-API FALLBACK)
            else if (command === '.verif') {
                const username = args[0] ? args[0].replace('@', '') : '';

                if (!username) {
                    await sock.sendMessage(from, { 
                        text: '⚠️ Harap masukkan username TikTok!\n\nContoh:\n*.verif tiktok*' 
                    }, { quoted: msg });
                    return;
                }

                try {
                    await sock.sendMessage(from, { text: '⏳ Sedang mengecek akun TikTok...' }, { quoted: msg });

                    let userData = null;

                    // Opsi 1: API Siputzx
                    try {
                        const res1 = await axios.get(`https://api.siputzx.my.id/api/stalk/tiktok?username=${username}`);
                        if (res1.data?.status && res1.data?.data) {
                            const u = res1.data.data.user;
                            const s = res1.data.data.stats;
                            userData = {
                                nickname: u.nickname,
                                username: u.uniqueId,
                                followers: s?.followerCount,
                                following: s?.followingCount,
                                likes: s?.heartCount,
                                video: s?.videoCount,
                                bio: u.signature,
                                avatar: u.avatarLarger || u.avatarMedium
                            };
                        }
                    } catch (e) {}

                    // Opsi 2: API Tiklydown (Backup 1)
                    if (!userData) {
                        try {
                            const res2 = await axios.get(`https://api.tiklydown.eu.org/api/download?url=https://www.tiktok.com/@${username}`);
                            if (res2.data?.author) {
                                const a = res2.data.author;
                                userData = {
                                    nickname: a.name,
                                    username: a.unique_id,
                                    followers: a.stats?.followerCount,
                                    following: a.stats?.followingCount,
                                    likes: a.stats?.heartCount,
                                    video: a.stats?.videoCount,
                                    bio: a.signature,
                                    avatar: a.avatar
                                };
                            }
                        } catch (e) {}
                    }

                    // Opsi 3: API VKRDown (Backup 2)
                    if (!userData) {
                        try {
                            const res3 = await axios.get(`https://api.vkrdown.com/tiktok/user.php?username=${username}`);
                            if (res3.data?.status === 'success' || res3.data?.user) {
                                const u = res3.data.user || res3.data;
                                userData = {
                                    nickname: u.nickname || u.name,
                                    username: u.uniqueId || u.username,
                                    followers: u.followerCount || u.followers,
                                    following: u.followingCount || u.following,
                                    likes: u.heartCount || u.hearts || u.likes,
                                    video: u.videoCount || u.videos,
                                    bio: u.signature || u.bio,
                                    avatar: u.avatarLarger || u.avatar || u.pp
                                };
                            }
                        } catch (e) {}
                    }

                    if (!userData) {
                        await sock.sendMessage(from, { text: '❌ Akun TikTok tidak ditemukan atau semua server API sedang dibatasi/down.' }, { quoted: msg });
                        return;
                    }

                    let teks = `✅ *VERIFIKASI AKUN TIKTOK*\n\n`;
                    teks += `👤 *Nama:* ${userData.nickname || '-'}\n`;
                    teks += `🆔 *Username:* @${userData.username || username}\n`;
                    teks += `👥 *Pengikut:* ${formatShortNumber(userData.followers)}\n`;
                    teks += `➡️ *Mengikuti:* ${formatShortNumber(userData.following)}\n`;
                    teks += `❤️ *Total Suka:* ${formatShortNumber(userData.likes)}\n`;
                    teks += `📹 *Total Video:* ${userData.video || 0}\n`;
                    teks += `📝 *Bio:* ${userData.bio || '-'}\n`;

                    if (userData.avatar) {
                        await sock.sendMessage(from, { image: { url: userData.avatar }, caption: teks }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: teks }, { quoted: msg });
                    }

                } catch (err) {
                    console.error('Error verif TikTok:', err.message);
                    await sock.sendMessage(from, { 
                        text: '❌ Gagal mengecek akun TikTok. Pastikan username benar.' 
                    }, { quoted: msg });
                }
            }

            // 6. FITUR .KICK
            else if (command === '.kick') {
                if (!isGroup) {
                    await sock.sendMessage(from, { text: '⚠️ Fitur ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    return;
                }

                const isFromMe = msg.key.fromMe;
                const punyaIzin = isFromMe || listBolehKick.includes(senderNumber);

                if (!punyaIzin) {
                    await sock.sendMessage(from, { text: '❌ Anda tidak memiliki izin untuk menggunakan perintah .kick!' }, { quoted: msg });
                    return;
                }

                try {
                    let targetUser = '';
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const mentionedJid = contextInfo?.mentionedJid;
                    const quotedParticipant = contextInfo?.participant;

                    if (mentionedJid && mentionedJid.length > 0) {
                        targetUser = mentionedJid[0];
                    } else if (quotedParticipant) {
                        targetUser = quotedParticipant;
                    }

                    if (!targetUser) {
                        await sock.sendMessage(from, { text: '⚠️ Tag orang yang ingin di-kick atau reply pesannya!\n\nContoh:\n*.kick @user*' }, { quoted: msg });
                        return;
                    }

                    await sock.groupParticipantsUpdate(from, [targetUser], 'remove');
                    await sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan @${targetUser.split('@')[0]} dari grup!`, mentions: [targetUser] }, { quoted: msg });

                } catch (err) {
                    console.error('Error kick:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengeluarkan member. Pastikan **Bot sudah diangkat menjadi Admin grup**!' }, { quoted: msg });
                }
            }
        }
    });
}

startBot();
