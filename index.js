const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// LIST NOMOR YANG DIIZINKAN
const listBolehKick = ['6281298697777'];
const listBolehHidetag = ['6281298697777'];

function formatNumber(num) {
    if (!num) return '0';
    return Number(num).toLocaleString('id-ID');
}

// Helper Konversi Foto / Stiker Ke Stiker Ber-Watermark Exif
async function imageToSticker(buffer, packname = 'Bot Stiker', author = 'Bot WhatsApp') {
    const tmpInput = path.join(__dirname, `tmp_${Date.now()}.jpg`);
    const tmpOutput = path.join(__dirname, `tmp_${Date.now()}.webp`);
    const tmpExif = path.join(__dirname, `tmp_${Date.now()}.exif`);
    const tmpFinal = path.join(__dirname, `tmp_final_${Date.now()}.webp`);
    
    fs.writeFileSync(tmpInput, buffer);

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

    return new Promise((resolve, reject) => {
        ffmpeg(tmpInput)
            .outputOptions([
                '-vcodec libwebp',
                '-vf scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-ih)/2:(oh-ih)/2:color=0x00000000'
            ])
            .toFormat('webp')
            .save(tmpOutput)
            .on('end', () => {
                exec(`webpmux -set exif ${tmpExif} ${tmpOutput} -o ${tmpFinal}`, (err) => {
                    let finalBuf;
                    if (!err && fs.existsSync(tmpFinal)) {
                        finalBuf = fs.readFileSync(tmpFinal);
                    } else {
                        finalBuf = fs.readFileSync(tmpOutput);
                    }

                    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
                    if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
                    if (fs.existsSync(tmpExif)) fs.unlinkSync(tmpExif);
                    if (fs.existsSync(tmpFinal)) fs.unlinkSync(tmpFinal);

                    resolve(finalBuf);
                });
            })
            .on('error', (err) => {
                if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
                if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
                if (fs.existsSync(tmpExif)) fs.unlinkSync(tmpExif);
                if (fs.existsSync(tmpFinal)) fs.unlinkSync(tmpFinal);
                reject(err);
            });
    });
}

// FUNGSI CEK TIKTOK MENGGUNAKAN API.VREDEN.WEB.ID (DENGAN FALLBACK FAILSAFE)
async function cekTiktok(username) {
    try {
        const cleanUser = encodeURIComponent(username.replace('@', '').trim());
        const response = await axios.get(`https://api.vreden.web.id/api/tiktokstalk?username=${cleanUser}`, { timeout: 10000 });

        if (response.data && response.data.result) {
            const result = response.data.result;
            return {
                status: true,
                nickname: result.nickname || username,
                username: result.username || username,
                avatar: result.avatar || result.profile || result.avatarLarger,
                followers: formatNumber(result.followers || result.follower || result.followerCount),
                videoCount: formatNumber(result.video || result.videos || result.videoCount),
                bio: result.bio || result.signature || 'Tidak ada bio'
            };
        }
    } catch (error) {
        console.error('Gagal mengambil data via Vreden API:', error.message);
    }

    // Fallback Cadangan (Jika Vreden API Bermasalah)
    try {
        const cleanUser = encodeURIComponent(username.replace('@', '').trim());
        const res2 = await axios.get(`https://tikwm.com/api/user/info?unique_id=${cleanUser}`, { timeout: 10000 });
        if (res2.data && res2.data.code === 0 && res2.data.data) {
            const u = res2.data.data.user;
            const s = res2.data.data.stats;
            return {
                status: true,
                nickname: u.nickname || username,
                username: u.unique_id || username,
                avatar: u.avatar_larger || u.avatar_medium,
                followers: formatNumber(s.followerCount),
                videoCount: formatNumber(s.videoCount),
                bio: u.signature || 'Tidak ada bio'
            };
        }
    } catch (err) {
        console.error('Gagal mengambil data via TikWM API:', err.message);
    }

    return { status: false };
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

            // 5. FITUR .KICK
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

            // 6. FITUR .VERIF (INTEGRASI DENGAN CEKTIKTOK)
            else if (command === '.verif' || command === '.verifikasi') {
                try {
                    const usernameInput = args.join(' ').trim();

                    if (!usernameInput) {
                        await sock.sendMessage(from, { text: `⚠️ *Format Verifikasi Salah!*\n\nContoh:\n*.verif moenzyy7*` }, { quoted: msg });
                        return;
                    }

                    await sock.sendMessage(from, { text: '⏳ *Sedang memverifikasi data akun TikTok...*' }, { quoted: msg });

                    const dataTikTok = await cekTiktok(usernameInput);

                    if (dataTikTok.status) {
                        let caption = `✅ *VERIFIKASI AKUN TIKTOK BERHASIL*\n\n`;
                        caption += `📛 *Display Name:* ${dataTikTok.nickname}\n`;
                        caption += `🆔 *Username:* @${dataTikTok.username}\n`;
                        caption += `👥 *Followers:* ${dataTikTok.followers}\n`;
                        caption += `🎬 *Total Video:* ${dataTikTok.videoCount}\n`;
                        caption += `📝 *Bio:* ${dataTikTok.bio}\n\n`;
                        caption += `👤 *Diverifikasi Oleh:* @${senderNumber}\n`;
                        caption += `✨ Status: *AKUN RESMI TERVERIFIKASI*`;

                        if (dataTikTok.avatar) {
                            await sock.sendMessage(from, { 
                                image: { url: dataTikTok.avatar },
                                caption: caption,
                                mentions: [rawSender]
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(from, { 
                                text: caption,
                                mentions: [rawSender]
                            }, { quoted: msg });
                        }
                    } else {
                        await sock.sendMessage(from, { 
                            text: `❌ *Gagal mengambil data akun TikTok "${usernameInput.replace('@', '')}".*\nPastikan username benar dan tidak di-private.` 
                        }, { quoted: msg });
                    }

                } catch (err) {
                    console.error('Error verif:', err);
                    await sock.sendMessage(from, { text: '❌ Terjadi kesalahan sistem saat verifikasi.' }, { quoted: msg });
                }
            }
        }
    });
}

startBot();
