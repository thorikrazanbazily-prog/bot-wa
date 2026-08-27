const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
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

// Helper Konversi Format Angka Singkat (contoh: 1400 -> 1,4 rb, 233000 -> 233 rb)
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

// FUNGSI CEK TIKTOK STALK UNTUK VERIFIKASI
async function cekTiktok(username) {
    const cleanUser = encodeURIComponent(username.replace('@', '').trim());

    // API 1: TikWM (Sangat detail untuk data Like/Heart & Follower)
    try {
        const res = await axios.get(`https://tikwm.com/api/user/info?unique_id=${cleanUser}`, { timeout: 10000 });
        if (res.data && res.data.code === 0 && res.data.data) {
            const u = res.data.data.user;
            const s = res.data.data.stats;
            return {
                status: true,
                nickname: u.nickname || username,
                username: u.unique_id || username,
                avatar: u.avatar_larger || u.avatar_medium,
                followers: formatShortNumber(s.followerCount),
                likes: formatShortNumber(s.heartCount || s.heart || 0)
            };
        }
    } catch (err) {}

    // API 2: Vreden API Fallback
    try {
        const response = await axios.get(`https://api.vreden.web.id/api/tiktokstalk?username=${cleanUser}`, { timeout: 10000 });
        if (response.data && response.data.result) {
            const result = response.data.result;
            return {
                status: true,
                nickname: result.nickname || username,
                username: result.username || username,
                avatar: result.avatar || result.profile || result.avatarLarger,
                followers: formatShortNumber(result.followers || result.follower),
                likes: formatShortNumber(result.likes || result.heart || 0)
            };
        }
    } catch (error) {}

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

            // 6. FITUR .VERIF (DESAIN SESUAI SCREENSHOT)
            else if (command === '.verif' || command === '.verifikasi') {
                try {
                    const usernameInput = args.join(' ').trim();

                    if (!usernameInput) {
                        await sock.sendMessage(from, { text: `⚠️ *Format Verifikasi Salah!*\n\nContoh:\n*.verif moenzyy7*` }, { quoted: msg });
                        return;
                    }

                    const cleanUser = usernameInput.replace('@', '');
                    
                    // Pesan Tunggu
                    await sock.sendMessage(from, { text: '⏳ *Sedang memverifikasi data akun TikTok...*' }, { quoted: msg });

                    const dataTikTok = await cekTiktok(cleanUser);

                    if (dataTikTok.status) {
                        // Caption persis tampilan screenshot
                        let caption = `✅ *Verifikasi Berhasil!*\n`;
                        caption += `--------------------------------------------------\n`;
                        caption += `• Username: @${dataTikTok.username}\n`;
                        caption += `• Follower: ${dataTikTok.followers}\n`;
                        caption += `• Like: ${dataTikTok.likes}\n`;
                        caption += `--------------------------------------------------`;

                        // ContextInfo untuk Header WhatsApp Card (Changli MD / AdReply Header)
                        const contextInfo = {
                            externalAdReply: {
                                title: "WhatsApp  • Status",
                                body: "🛒 2009 item\nChangli MD",
                                mediaType: 1,
                                renderLargerThumbnail: false,
                                thumbnailUrl: "https://files.catbox.moe/k3u6y7.jpg", // Menggunakan foto karakter Anime/Changli
                                sourceUrl: "https://whatsapp.com"
                            }
                        };

                        if (dataTikTok.avatar) {
                            await sock.sendMessage(from, {
                                image: { url: dataTikTok.avatar },
                                caption: caption,
                                contextInfo: contextInfo
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(from, {
                                text: caption,
                                contextInfo: contextInfo
                            }, { quoted: msg });
                        }
                    } else {
                        await sock.sendMessage(from, { 
                            text: `❌ *Gagal mengambil data akun TikTok "${cleanUser}".*\nPastikan username benar dan tidak di-private.` 
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
