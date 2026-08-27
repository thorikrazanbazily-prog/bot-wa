const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

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

            // FITUR .LISTFITUR / .MENU
            else if (command === '.listfitur' || command === '.menu' || command === '.help') {
                let menuText = `🤤 *DAFTAR FITUR BOT RIQ* 🤤\n\n`;
                menuText += `⚡ *Utilities & System*\n`;
                menuText += `• \`.ping\` - Mengecek kecepatan respon bot (ms)\n\n`;
                
                menuText += `👥 *Group Management*\n`;
                menuText += `• \`.listmem\` - Menampilkan daftar seluruh anggota grup\n\n`;
                
                menuText += `🎨 *Sticker Creator*\n`;
                menuText += `• \`.stiker\` / \`.s\` - Membuat stiker dari gambar (kirim/reply foto)\n`;
                menuText += `• \`.wm <pack | author>\` - Membuat stiker dengan watermark kustom\n\n`;
                
                menuText += `✨ Silakan gunakan fitur di atas sesuai kebutuhan!`;

                await sock.sendMessage(from, { text: menuText }, { quoted: msg });
            }

            // 3 & 4. FITUR .STIKER / .S & .WM
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
        }
    });
}

startBot();
