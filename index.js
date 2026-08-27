const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');

// LIST NOMOR OWNER / YANG DIIZINKAN
const ownerNumber = ['6281298697777'];

// File untuk mencatat aktivitas member (Sider Detector)
const activityFile = path.join(__dirname, 'group_activity.json');
const modeFile = path.join(__dirname, 'bot_mode.json');

function getBotMode() {
    if (fs.existsSync(modeFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(modeFile));
            return data.mode || 'public';
        } catch (e) {
            return 'public';
        }
    }
    return 'public';
}

function setBotMode(mode) {
    fs.writeFileSync(modeFile, JSON.stringify({ mode }, null, 2));
}

function trackActivity(groupId, senderId) {
    if (!groupId || !senderId) return;
    const cleanSender = jidNormalizedUser(senderId);
    let activity = fs.existsSync(activityFile) ? JSON.parse(fs.readFileSync(activityFile)) : {};
    if (!activity[groupId]) activity[groupId] = {};
    
    activity[groupId][cleanSender] = Date.now();
    fs.writeFileSync(activityFile, JSON.stringify(activity, null, 2));
}

async function imageToSticker(buffer, packname = 'Bot Stiker', author = 'WhatsApp Bot') {
    const webpBuffer = await sharp(buffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toFormat('webp')
        .toBuffer();

    const tmpOutput = path.join(__dirname, `tmp_${Date.now()}.webp`);
    const tmpExif = path.join(__dirname, `tmp_${Date.now()}.exif`);
    const tmpFinal = path.join(__dirname, `tmp_final_${Date.now()}.webp`);

    fs.writeFileSync(tmpOutput, webpBuffer);

    const json = {
        'sticker-pack-id': 'WhatsApp Bot',
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
            try {
                if (!msg.message) continue;

                const from = msg.key.remoteJid;
                const isGroup = from.endsWith('@g.us');

                // Normalisasi JID pengirim agar tidak bermasalah dengan multi-device
                const rawSender = msg.key.participant || msg.participant || msg.key.remoteJid || '';
                const senderJid = jidNormalizedUser(rawSender);
                const senderNumber = senderJid.split('@')[0];
                const isOwner = ownerNumber.includes(senderNumber) || msg.key.fromMe;

                // Cek Mode Bot
                const botMode = getBotMode();
                if (botMode === 'private' && !isOwner) return;

                // Cek Banned User
                const banFile = path.join(__dirname, 'banned.json');
                let banned = fs.existsSync(banFile) ? JSON.parse(fs.readFileSync(banFile)) : [];
                if (banned.includes(senderNumber)) return;

                if (isGroup) {
                    trackActivity(from, senderJid);
                }

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
                    await sock.sendMessage(from, { text: `🏓 *Pong!*\n⚡ Kecepatan respon: *${latency} ms*` }, { quoted: msg });
                }

                // 2. FITUR .LISTMEM
                else if (command === '.listmem') {
                    if (!isGroup) {
                        await sock.sendMessage(from, { text: '⚠️ Fitur ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                        return;
                    }

                    const groupMetadata = await sock.groupMetadata(from);
                    const participants = groupMetadata.participants;
                    
                    let teks = `📋 *DAFTAR MEMBER GRUP*\n`;
                    teks += `👥 *Total:* ${participants.length} Anggota\n\n`;

                    let mentions = [];
                    participants.forEach((mem, index) => {
                        teks += `${index + 1}. @${mem.id.split('@')[0]}\n`;
                        mentions.push(mem.id);
                    });

                    await sock.sendMessage(from, { text: teks, mentions: mentions }, { quoted: msg });
                }

                // 3. FITUR .STIKER & .WM
                else if (command === '.stiker' || command === '.s' || command === '.wm') {
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const typeQuoted = quoted ? Object.keys(quoted)[0] : null;

                    const isImage = msg.message.imageMessage;
                    const isQuotedImage = typeQuoted === 'imageMessage';
                    const isSticker = msg.message.stickerMessage;
                    const isQuotedSticker = typeQuoted === 'stickerMessage';

                    if (!isImage && !isQuotedImage && !isSticker && !isQuotedSticker) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim atau reply foto dengan perintah *.stiker* atau *.wm*!' }, { quoted: msg });
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
                    let author = 'WhatsApp Bot';
                    if (command === '.wm') {
                        const fullText = args.join(' ').trim();
                        if (fullText.includes('|')) {
                            const splitText = fullText.split('|');
                            packname = splitText[0].trim() || 'Bot Stiker';
                            author = splitText[1].trim() || 'WhatsApp Bot';
                        }
                    }

                    const buffer = await downloadMediaMessage(mediaToDownload, 'buffer', {});
                    const stickerBuffer = await imageToSticker(buffer, packname, author);
                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
                }

                // 4. FITUR .MENU
                else if (command === '.listfitur' || command === '.menu' || command === '.help') {
                    let menuText = `🤖 *DAFTAR FITUR BOT WHATSAPP* 🤖\n\n`;
                    menuText += `• \`.ping\` - Cek kecepatan bot\n`;
                    menuText += `• \`.listmem\` - Daftar member grup\n`;
                    menuText += `• \`.kick @user\` - Mengeluarkan member (*Khusus Admin Grup*)\n`;
                    menuText += `• \`.ban\` - Ban member (Owner)\n`;
                    menuText += `• \`.ceksider\` - Cek anggota yang tidak pernah chat\n`;
                    menuText += `• \`.kicksider\` - Kick otomatis anggota sider (*Khusus Admin Grup*)\n`;
                    menuText += `• \`.private\` - Ubah bot ke mode privat (Owner)\n`;
                    menuText += `• \`.public\` / \`.publik\` - Ubah bot ke mode publik (Owner)\n`;
                    menuText += `• \`.stiker\` / \`.wm\` - Buat stiker\n`;
                    menuText += `• \`.removebg\` - Hapus background foto (Reply foto)\n`;
                    menuText += `• \`.hd\` - Upscale foto 2x lipat (Reply foto)\n`;
                    menuText += `• \`.hdvideo\` - Upscale video 2x lipat (Reply video)\n`;
                    menuText += `• \`.getip <ip/domain>\` - Cek informasi IP / Domain\n`;
                    menuText += `• \`.rpg\` - Berburu monster RPG\n`;

                    await sock.sendMessage(from, { text: menuText }, { quoted: msg });
                }

                // 5. FITUR .KICK (SUDAH DIPERBAIKI)
                else if (command === '.kick') {
                    if (!isGroup) {
                        await sock.sendMessage(from, { text: '⚠️ Fitur ini khusus di dalam grup!' }, { quoted: msg });
                        return;
                    }

                    const groupMetadata = await sock.groupMetadata(from);
                    const participants = groupMetadata.participants;

                    // Perbandingan JID yang dinormalisasi
                    const participant = participants.find(p => jidNormalizedUser(p.id) === senderJid);
                    const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

                    if (!isAdmin && !isOwner) {
                        await sock.sendMessage(from, { text: '❌ Perintah ini hanya dapat digunakan oleh *Admin Grup*!' }, { quoted: msg });
                        return;
                    }

                    const botJid = jidNormalizedUser(sock.user.id);
                    const botPart = participants.find(p => jidNormalizedUser(p.id) === botJid);
                    const isBotAdmin = botPart && (botPart.admin === 'admin' || botPart.admin === 'superadmin');

                    if (!isBotAdmin) {
                        await sock.sendMessage(from, { text: '❌ Gagal! Bot harus dijadikan *Admin Grup* terlebih dahulu.' }, { quoted: msg });
                        return;
                    }

                    let rawTarget = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                                    msg.message.extendedTextMessage?.contextInfo?.participant;
                    
                    if (!rawTarget && args[0]) {
                        rawTarget = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    }

                    if (!rawTarget) {
                        await sock.sendMessage(from, { text: '⚠️ Silakan tag, reply, atau sertakan nomor orang yang ingin dikeluarkan!' }, { quoted: msg });
                        return;
                    }

                    const targetUser = jidNormalizedUser(rawTarget);

                    try {
                        await sock.groupParticipantsUpdate(from, [targetUser], 'remove');
                        await sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan @${targetUser.split('@')[0]} dari grup.`, mentions: [targetUser] }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(from, { text: `❌ Gagal mengeluarkan member. Pastikan posisi bot lebih tinggi dari target.` }, { quoted: msg });
                    }
                }

                // 6. FITUR .PRIVATE & .PUBLIC
                else if (command === '.private') {
                    if (!isOwner) {
                        await sock.sendMessage(from, { text: '❌ Perintah ini hanya khusus untuk Owner bot!' }, { quoted: msg });
                        return;
                    }
                    setBotMode('private');
                    await sock.sendMessage(from, { text: '🔒 Bot berhasil diubah ke mode *PRIVATE*. Sekarang hanya Owner yang dapat menggunakan bot.' }, { quoted: msg });
                }

                else if (command === '.public' || command === '.publik') {
                    if (!isOwner) {
                        await sock.sendMessage(from, { text: '❌ Perintah ini hanya khusus untuk Owner bot!' }, { quoted: msg });
                        return;
                    }
                    setBotMode('public');
                    await sock.sendMessage(from, { text: '🌐 Bot berhasil diubah ke mode *PUBLIC*. Sekarang semua orang dapat menggunakan bot.' }, { quoted: msg });
                }

                // 7. FITUR .BAN
                else if (command === '.ban') {
                    if (!isOwner) return;
                    let target = msg.message.extendedTextMessage?.contextInfo?.participant || msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0];
                    if (!target) {
                        await sock.sendMessage(from, { text: '⚠️ Tag atau masukkan nomor yang ingin di-ban!' }, { quoted: msg });
                        return;
                    }
                    const banNum = target.replace(/[^0-9]/g, '');
                    if (!banned.includes(banNum)) banned.push(banNum);
                    fs.writeFileSync(banFile, JSON.stringify(banned, null, 2));
                    await sock.sendMessage(from, { text: `🚫 Nomor @${banNum} berhasil dibanned.`, mentions: [`${banNum}@s.whatsapp.net`] }, { quoted: msg });
                }

                // 8. FITUR .CEKSIDER & .KICKSIDER
                else if (command === '.ceksider' || command === '.kicksider') {
                    if (!isGroup) {
                        await sock.sendMessage(from, { text: '⚠️ Fitur ini khusus di dalam grup!' }, { quoted: msg });
                        return;
                    }

                    const groupMetadata = await sock.groupMetadata(from);
                    const participants = groupMetadata.participants;

                    const participant = participants.find(p => jidNormalizedUser(p.id) === senderJid);
                    const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

                    if (command === '.kicksider' && !isAdmin && !isOwner) {
                        await sock.sendMessage(from, { text: '❌ Perintah `.kicksider` hanya dapat digunakan oleh *Admin Grup*!' }, { quoted: msg });
                        return;
                    }
                    
                    let activity = fs.existsSync(activityFile) ? JSON.parse(fs.readFileSync(activityFile)) : {};
                    let groupAct = activity[from] || {};

                    const botJid = jidNormalizedUser(sock.user.id);
                    let siders = [];
                    participants.forEach(mem => {
                        const memJid = jidNormalizedUser(mem.id);
                        if (!groupAct[memJid] && memJid !== botJid) {
                            siders.push(memJid);
                        }
                    });

                    if (siders.length === 0) {
                        await sock.sendMessage(from, { text: '✨ Tidak ada anggota sider (semua member tercatat pernah aktif berkirim pesan).' }, { quoted: msg });
                        return;
                    }

                    if (command === '.ceksider') {
                        let teks = `👀 *DAFTAR ANGGOTA SIDER (BELUM PERNAH CHAT)*\n\n`;
                        let mentions = [];
                        siders.forEach((id, idx) => {
                            teks += `${idx + 1}. @${id.split('@')[0]}\n`;
                            mentions.push(id);
                        });
                        await sock.sendMessage(from, { text: teks, mentions: mentions }, { quoted: msg });
                    } else if (command === '.kicksider') {
                        const botPart = participants.find(p => jidNormalizedUser(p.id) === botJid);
                        const isBotAdmin = botPart && (botPart.admin === 'admin' || botPart.admin === 'superadmin');

                        if (!isBotAdmin) {
                            await sock.sendMessage(from, { text: '❌ Gagal! Bot harus dijadikan *Admin Grup* terlebih dahulu.' }, { quoted: msg });
                            return;
                        }

                        await sock.sendMessage(from, { text: `🧹 Membersihkan ${siders.length} anggota sider dari grup...` }, { quoted: msg });
                        for (let siderId of siders) {
                            try {
                                await sock.groupParticipantsUpdate(from, [siderId], 'remove');
                                await new Promise(resolve => setTimeout(resolve, 2000));
                            } catch (e) {
                                console.error(`Gagal kick sider ${siderId}:`, e.message);
                            }
                        }
                        await sock.sendMessage(from, { text: '✅ Selesai membersihkan anggota sider!' }, { quoted: msg });
                    }
                }

                // 9. FITUR .REMOVEBG
                else if (command === '.removebg') {
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const typeQuoted = quoted ? Object.keys(quoted)[0] : null;
                    const isImage = msg.message.imageMessage || typeQuoted === 'imageMessage';

                    if (!isImage) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim atau reply foto dengan caption *.removebg*!' }, { quoted: msg });
                        return;
                    }

                    await sock.sendMessage(from, { text: '⏳ Sedang memproses penghapusan background...' }, { quoted: msg });

                    let mediaToDownload = quoted ? {
                        key: { 
                            remoteJid: from, 
                            id: msg.message.extendedTextMessage?.contextInfo?.stanzaId, 
                            participant: msg.message.extendedTextMessage?.contextInfo?.participant 
                        },
                        message: quoted
                    } : msg;

                    const buffer = await downloadMediaMessage(mediaToDownload, 'buffer', {});
                    const base64Image = buffer.toString('base64');
                    
                    const apiRes = await axios.post('https://api.betabotz.eu.org/api/tools/removebg', {
                        image: `data:image/jpeg;base64,${base64Image}`,
                        apikey: 'Btz-L6YG6'
                    }).catch(() => null);

                    let imageUrl = apiRes?.data?.result;
                    if (imageUrl) {
                        await sock.sendMessage(from, { image: { url: imageUrl }, caption: '✅ Background berhasil dihapus!' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ Gagal memproses removebg. Server API sedang bermasalah atau limit habis.' }, { quoted: msg });
                    }
                }

                // 10. FITUR .HD
                else if (command === '.hd') {
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const typeQuoted = quoted ? Object.keys(quoted)[0] : null;
                    const isImage = msg.message.imageMessage || typeQuoted === 'imageMessage';

                    if (!isImage) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim atau reply foto dengan caption *.hd*!' }, { quoted: msg });
                        return;
                    }

                    await sock.sendMessage(from, { text: '⏳ Sedang melakukan upscale foto 2x lipat...' }, { quoted: msg });

                    let mediaToDownload = quoted ? {
                        key: { 
                            remoteJid: from, 
                            id: msg.message.extendedTextMessage?.contextInfo?.stanzaId, 
                            participant: msg.message.extendedTextMessage?.contextInfo?.participant 
                        },
                        message: quoted
                    } : msg;

                    const buffer = await downloadMediaMessage(mediaToDownload, 'buffer', {});
                    
                    const imageMetadata = await sharp(buffer).metadata();
                    const targetWidth = (imageMetadata.width || 800) * 2;

                    const enhancedBuffer = await sharp(buffer)
                        .resize({ width: targetWidth, fit: 'contain' })
                        .sharpen()
                        .modulate({ brightness: 1.05, saturation: 1.1 })
                        .toFormat('jpeg', { quality: 100 })
                        .toBuffer();

                    await sock.sendMessage(from, { image: enhancedBuffer, caption: '✅ Berhasil upscale foto menjadi 2x lipat (HD)!' }, { quoted: msg });
                }

                // 11. FITUR .HDVIDEO
                else if (command === '.hdvideo' || command === '.reminivideo') {
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const typeQuoted = quoted ? Object.keys(quoted)[0] : null;
                    const isVideo = msg.message.videoMessage || typeQuoted === 'videoMessage';

                    if (!isVideo) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim atau reply video dengan caption *.hdvideo*!' }, { quoted: msg });
                        return;
                    }

                    await sock.sendMessage(from, { text: '⏳ Sedang memproses upscale resolusi video 2x lipat...' }, { quoted: msg });

                    let mediaToDownload = quoted ? {
                        key: { 
                            remoteJid: from, 
                            id: msg.message.extendedTextMessage?.contextInfo?.stanzaId, 
                            participant: msg.message.extendedTextMessage?.contextInfo?.participant 
                        },
                        message: quoted
                    } : msg;

                    const buffer = await downloadMediaMessage(mediaToDownload, 'buffer', {});
                    const base64Video = buffer.toString('base64');

                    const apiRes = await axios.post('https://api.betabotz.eu.org/api/tools/reminivideo', {
                        video: `data:video/mp4;base64,${base64Video}`,
                        scale: 2,
                        apikey: 'Btz-L6YG6'
                    }).catch(() => null);

                    if (apiRes && apiRes.data && apiRes.data.result) {
                        await sock.sendMessage(from, { video: { url: apiRes.data.result }, caption: '✅ Berhasil upscale video 2x lipat (HD)!' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ Server API video gagal merespon atau batas limit tercapai.' }, { quoted: msg });
                    }
                }

                // 12. FITUR .GETIP
                else if (command === '.getip') {
                    const targetIp = args[0];
                    if (!targetIp) {
                        await sock.sendMessage(from, { text: '⚠️ Masukkan alamat IP atau Domain web!\nContoh: `.getip 8.8.8.8`' }, { quoted: msg });
                        return;
                    }

                    await sock.sendMessage(from, { text: `🔍 Sedang melacak informasi untuk: *${targetIp}*...` }, { quoted: msg });

                    const response = await axios.get(`http://ip-api.com/json/${targetIp}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
                    const data = response.data;

                    if (data.status === 'fail') {
                        await sock.sendMessage(from, { text: `❌ Gagal melacak IP/Domain. Pesan: ${data.message}` }, { quoted: msg });
                        return;
                    }

                    let teks = `🌐 *INFORMASI IP / DOMAIN* 🌐\n\n`;
                    teks += `• *IP/Host:* ${data.query}\n`;
                    teks += `• *Negara:* ${data.country} (${data.countryCode})\n`;
                    teks += `• *Wilayah:* ${data.regionName}\n`;
                    teks += `• *Kota:* ${data.city} (${data.zip})\n`;
                    teks += `• *ISP:* ${data.isp}\n`;
                    teks += `• *Organisasi:* ${data.org || '-'}\n`;
                    teks += `• *Zona Waktu:* ${data.timezone}\n`;

                    await sock.sendMessage(from, { text: teks }, { quoted: msg });
                }

                // 13. FITUR RPG
                else if (command === '.rpg' || command === '.hunt') {
                    const rpgFile = path.join(__dirname, 'rpg_users.json');
                    let rpgData = fs.existsSync(rpgFile) ? JSON.parse(fs.readFileSync(rpgFile)) : {};

                    if (!rpgData[senderNumber]) {
                        rpgData[senderNumber] = { name: msg.pushName || 'Player', health: 100, exp: 0, level: 1, gold: 100, lastHunt: 0 };
                    }

                    let player = rpgData[senderNumber];
                    const cooldown = 15000;
                    if (Date.now() - player.lastHunt < cooldown) {
                        const timeLeft = Math.ceil((cooldown - (Date.now() - player.lastHunt)) / 1000);
                        await sock.sendMessage(from, { text: `⏳ Tunggu *${timeLeft} detik* lagi sebelum berburu!` }, { quoted: msg });
                        return;
                    }

                    player.lastHunt = Date.now();
                    player.exp += 50;
                    player.gold += 25;
                    fs.writeFileSync(rpgFile, JSON.stringify(rpgData, null, 2));

                    await sock.sendMessage(from, { text: `⚔️ Berhasil berburu monster!\n✨ EXP +50\n🪙 Gold +25\n⭐ Level: ${player.level}` }, { quoted: msg });
                }

            } catch (err) {
                console.error(`Error pada command handler:`, err);
            }
        }
    });
}

startBot();
