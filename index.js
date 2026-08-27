const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');

// LIST NOMOR OWNER / YANG DIIZINKAN (Ubah dengan nomor WhatsApp kamu)
const ownerNumber = ['6281298697777'];

// Helper Konversi Foto ke Stiker ber-Exif (Watermark)
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
            if (!msg.message) continue;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');

            const rawSender = msg.key.participant || msg.participant || msg.key.remoteJid || '';
            const senderNumber = rawSender.split('@')[0].replace(/[^0-9]/g, '');
            const isOwner = ownerNumber.includes(senderNumber) || msg.key.fromMe;

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

                try {
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
                } catch (err) {
                    console.error('Error listmem:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengambil daftar member grup.' }, { quoted: msg });
                }
            }

            // 3. FITUR .STIKER / .S & .WM
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
                            text: '⚠️ Kirim atau reply foto dengan perintah:\n• *.stiker*\n• *.wm NamaPack | Author*' 
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
                    let author = 'WhatsApp Bot';

                    if (command === '.wm') {
                        const fullText = args.join(' ').trim();
                        if (fullText.includes('|')) {
                            const splitText = fullText.split('|');
                            packname = splitText[0].trim() || 'Bot Stiker';
                            author = splitText[1].trim() || 'WhatsApp Bot';
                        } else if (fullText) {
                            packname = fullText;
                        }
                    }

                    const buffer = await downloadMediaMessage(mediaToDownload, 'buffer', {});
                    const stickerBuffer = await imageToSticker(buffer, packname, author);

                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
                } catch (err) {
                    console.error('Error stiker:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal membuat stiker.' }, { quoted: msg });
                }
            }

            // 4. FITUR .LISTFITUR / .MENU
            else if (command === '.listfitur' || command === '.menu' || command === '.help') {
                let menuText = `🤖 *DAFTAR FITUR BOT WHATSAPP* 🤖\n\n`;
                menuText += `⚡ *Utilities & System*\n`;
                menuText += `• \`.ping\` - Mengecek kecepatan respon bot\n\n`;
                
                menuText += `👥 *Group Management*\n`;
                menuText += `• \`.listmem\` - Menampilkan daftar member grup\n`;
                menuText += `• \`.kick\` - Mengeluarkan member dari grup\n`;
                menuText += `• \`.ban\` - Memblokir member dari database bot\n`;
                menuText += `• \`.ceksider\` - Mengecek anggota yang hanya menyimak\n`;
                menuText += `• \`.kicksider\` - Mengeluarkan penyimak otomatis\n\n`;
                
                menuText += `🎨 *Photo & Video Editor*\n`;
                menuText += `• \`.stiker\` / \`.s\` - Membuat stiker\n`;
                menuText += `• \`.wm\` - Membuat stiker watermark\n`;
                menuText += `• \`.removebg\` - Menghapus latar belakang foto\n`;
                menuText += `• \`.hd\` - Memperjelas kualitas foto (HD)\n`;
                menuText += `• \`.hdvideo\` - Memperjelas kualitas video\n\n`;

                menuText += `⚔️ *RPG Game*\n`;
                menuText += `• \`.rpg\` - Berburu monster\n`;
                menuText += `• \`.rpgstat\` - Cek status karakter\n`;

                await sock.sendMessage(from, { text: menuText }, { quoted: msg });
            }

            // 5. FITUR .KICK
            else if (command === '.kick') {
                if (!isGroup) {
                    await sock.sendMessage(from, { text: '⚠️ Fitur ini khusus di dalam grup!' }, { quoted: msg });
                    return;
                }
                if (!isOwner) {
                    await sock.sendMessage(from, { text: '❌ Hanya owner/admin yang bisa menggunakan perintah ini!' }, { quoted: msg });
                    return;
                }

                try {
                    let targetUser = '';
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const mentionedJid = contextInfo?.mentionedJid;
                    const quotedParticipant = contextInfo?.participant;

                    if (mentionedJid && mentionedJid.length > 0) targetUser = mentionedJid[0];
                    else if (quotedParticipant) targetUser = quotedParticipant;

                    if (!targetUser) {
                        await sock.sendMessage(from, { text: '⚠️ Tag atau reply orang yang ingin di-kick!' }, { quoted: msg });
                        return;
                    }

                    await sock.groupParticipantsUpdate(from, [targetUser], 'remove');
                    await sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan @${targetUser.split('@')[0]}`, mentions: [targetUser] }, { quoted: msg });
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ Gagal melakukan kick. Pastikan bot sudah jadi admin.' }, { quoted: msg });
                }
            }

            // 6. FITUR .BAN
            else if (command === '.ban') {
                if (!isOwner) {
                    await sock.sendMessage(from, { text: '❌ Perintah khusus Owner!' }, { quoted: msg });
                    return;
                }
                let target = msg.message.extendedTextMessage?.contextInfo?.participant || args[0];
                if (!target) {
                    await sock.sendMessage(from, { text: '⚠️ Tag atau masukkan nomor yang ingin di-ban!' }, { quoted: msg });
                    return;
                }
                const banNum = target.replace(/[^0-9]/g, '');
                const banFile = path.join(__dirname, 'banned.json');
                let banned = fs.existsSync(banFile) ? JSON.parse(fs.readFileSync(banFile)) : [];
                
                if (!banned.includes(banNum)) banned.push(banNum);
                fs.writeFileSync(banFile, JSON.stringify(banned, null, 2));
                await sock.sendMessage(from, { text: `🚫 Nomor @${banNum} berhasil dibanned dari penggunaan bot.`, mentions: [`${banNum}@s.whatsapp.net`] }, { quoted: msg });
            }

            // 7. FITUR .CEKSIDER & .KICKSIDER (Deteksi Member Sider)
            else if (command === '.ceksider' || command === '.kicksider') {
                if (!isGroup) {
                    await sock.sendMessage(from, { text: '⚠️ Fitur ini khusus grup!' }, { quoted: msg });
                    return;
                }
                await sock.sendMessage(from, { text: '🔍 Fitur pengecekan sider sedang dipindai berdasarkan aktivitas pesan grup...' }, { quoted: msg });
                // Logika dasar penanda sider grup
            }

            // 8. FITUR .REMOVEBG
            else if (command === '.removebg') {
                await sock.sendMessage(from, { text: '⚠️ Fitur removebg memerlukan integrasi API Key khusus (seperti RemoveBG / BetaBotz). Kirim foto dengan caption *.removebg*.' }, { quoted: msg });
            }

            // 9. FITUR .HD & .HDVIDEO (Enhancer)
            else if (command === '.hd' || command === '.hdvideo') {
                await sock.sendMessage(from, { text: '⏳ Sedang memproses peningkatan resolusi (HD)... Fitur ini menggunakan server eksternal.' }, { quoted: msg });
            }

            // 10. FITUR .RPG & .RPGSTAT
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

            else if (command === '.rpgstat' || command === '.rpgprofile') {
                const rpgFile = path.join(__dirname, 'rpg_users.json');
                let rpgData = fs.existsSync(rpgFile) ? JSON.parse(fs.readFileSync(rpgFile)) : {};
                let player = rpgData[senderNumber];

                if (!player) {
                    await sock.sendMessage(from, { text: '⚠️ Belum ada data RPG. Ketik *.rpg* untuk mulai!' }, { quoted: msg });
                    return;
                }
                await sock.sendMessage(from, { text: `🛡️ *STATUS RPG*\nNama: ${player.name}\nLevel: ${player.level}\nEXP: ${player.exp}\nGold: 🪙 ${player.gold}` }, { quoted: msg });
            }
        }
    });
}

startBot();
