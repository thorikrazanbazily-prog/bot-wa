const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const axios = require('axios');

// LIST NOMOR YANG DIIZINKAN UNTUK KICK & HIDETAG (Ubah sesuai nomor WhatsApp kamu)
const listBolehKick = ['6281298697777'];
const listBolehHidetag = ['6281298697777'];

// Helper Konversi Format Angka Singkat (K / M / B / rb / jt)
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

            // 1. FITUR .HIDETAG / .H
            if (command === '.hidetag' || command === '.h') {
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

            // 2. FITUR .VERIF TIKTOK (Menggunakan API Key Buatan Sendiri / Server Lokal)
            else if (command === '.verif') {
                const username = args[0] ? args[0].replace('@', '') : '';
                const apikey = 'apikey-kamu-123'; // Ganti dengan API Key buatanmu
                const apiUrl = `http://localhost:3000/api/stalk/tiktok?username=${username}&apikey=${apikey}`;

                if (!username) {
                    await sock.sendMessage(from, { 
                        text: '⚠️ Harap masukkan username TikTok!\n\nContoh:\n*.verif username*' 
                    }, { quoted: msg });
                    return;
                }

                try {
                    await sock.sendMessage(from, { text: '⏳ Sedang mengecek akun TikTok...' }, { quoted: msg });

                    const response = await axios.get(apiUrl).catch(() => null);

                    if (!response || !response.data || response.data.status !== 200 || !response.data.result) {
                        await sock.sendMessage(from, { 
                            text: '❌ Gagal mengambil data dari server API (Pastikan API Key atau server aktif)!' 
                        }, { quoted: msg });
                        return;
                    }

                    const data = response.data.result;

                    let teks = `✅ *VERIFIKASI AKUN TIKTOK*\n\n`;
                    teks += `👤 *Nama:* ${data.nickname || '-'}\n`;
                    teks += `🆔 *Username:* @${data.username || username}\n`;
                    teks += `👥 *Pengikut:* ${formatShortNumber(data.followers)}\n`;
                    teks += `❤️ *Total Suka:* ${formatShortNumber(data.likes)}\n`;
                    teks += `📝 *Bio:* ${data.bio || '-'}\n`;

                    await sock.sendMessage(from, { text: teks }, { quoted: msg });

                } catch (err) {
                    console.error('Error verif TikTok:', err.message);
                    await sock.sendMessage(from, { 
                        text: '❌ Terjadi kesalahan saat memproses data akun TikTok.' 
                    }, { quoted: msg });
                }
            }

            // 3. FITUR .GETIP
            else if (command === '.getip') {
                try {
                    const ipRes = await axios.get('https://api.ipify.org?format=json');
                    await sock.sendMessage(from, { text: `🌐 IP Perangkat ini adalah: *${ipRes.data.ip}*` }, { quoted: msg });
                } catch (e) {
                    await sock.sendMessage(from, { text: '❌ Gagal mengecek IP.' }, { quoted: msg });
                }
            }

            // 4. FITUR .KICK
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
