const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// ==========================================
// CONFIGURATION & DATABASE (In-Memory)
// ==========================================
const ownerNumber = ['6281298697777']; // Ganti dengan nomor WhatsApp kamu
let isPublic = true;                   // Status Mode Bot (.publik / .private)
const welcomeMessages = {};             // Menyimpan pesan welcome custom per grup
const tiktokDb = {};                    // Database verifikasi akun TikTok

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    // ==========================================
    // MANAGEMENT KONEKSI
    // ==========================================
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

    // ==========================================
    // FITUR SETWELCOME (Event Member Masuk)
    // ==========================================
    sock.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action } = update;
            if (action === 'add') {
                const customWelcome = welcomeMessages[id] || 'Selamat datang @user di grup!';
                for (const num of participants) {
                    const text = customWelcome.replace('@user', `@${num.split('@')[0]}`);
                    await sock.sendMessage(id, { text, mentions: [num] });
                }
            }
        } catch (err) {
            console.error('Error pada event welcome:', err);
        }
    });

    // ==========================================
    // COMMAND HANDLER
    // ==========================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                // Safe check pesan
                if (!msg.message || msg.key.fromMe) continue;

                const from = msg.key.remoteJid;
                const isGroup = from.endsWith('@g.us');
                const rawSender = msg.key.participant || msg.participant || msg.key.remoteJid || '';
                const senderNumber = rawSender.split('@')[0].replace(/[^0-9]/g, '');
                const isOwner = ownerNumber.includes(senderNumber);

                // Ekstraksi teks pesan yang lebih aman
                const body = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || '';
                             
                const pesan = body.trim();
                if (!pesan) continue;

                // Modul Mode Bot (.private / .publik)
                if (!isPublic && !isOwner) continue;

                // Handler Quick Chat (Ketik 'myinfo' atau '.myinfo')
                if (pesan.toLowerCase() === 'myinfo' || pesan.toLowerCase() === '.myinfo') {
                    const data = tiktokDb[senderNumber];
                    if (!data) {
                        await sock.sendMessage(from, { text: '❌ Kamu belum memverifikasi akun TikTok!' }, { quoted: msg });
                    } else {
                        const infoText = `📋 *INFORMASI AKUN TIKTOK*\n\n` +
                                         `• *WhatsApp:* @${senderNumber}\n` +
                                         `• *Username TikTok:* @${data.username}\n` +
                                         `• *Status Verifikasi:* Verified ✅\n` +
                                         `• *Waktu Verifikasi:* ${data.time}`;
                        await sock.sendMessage(from, { text: infoText, mentions: [rawSender] }, { quoted: msg });
                    }
                    continue;
                }

                if (!pesan.startsWith('.')) continue;

                const command = pesan.toLowerCase().split(' ')[0];
                const args = pesan.split(' ').slice(1);

                // Helper Pengecekan Admin (Metode Normalisasi Angka)
                let isAdmin = false;
                let isBotAdmin = false;
                if (isGroup) {
                    const groupMetadata = await sock.groupMetadata(from);
                    const participants = groupMetadata.participants;

                    // Cek Admin Pengirim
                    const senderPart = participants.find(p => p.id.split('@')[0].replace(/[^0-9]/g, '') === senderNumber);
                    isAdmin = senderPart && (senderPart.admin === 'admin' || senderPart.admin === 'superadmin');

                    // Cek Admin Bot (Anti-Undefined)
                    const rawBotId = sock.user?.id || '';
                    const botCleanNumber = rawBotId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                    const botPart = participants.find(p => p.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') === botCleanNumber);
                    isBotAdmin = botPart && (botPart.admin === 'admin' || botPart.admin === 'superadmin');
                }

                // Helper Target User
                const quoted = msg.message.extendedTextMessage?.contextInfo;
                let targetUser = quoted?.mentionedJid?.[0] || quoted?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);

                // ------------------------------------------
                // 1. FITUR .MENU
                // ------------------------------------------
                if (command === '.menu') {
                    const menuText = `🤖 *BOT MULTIFUNGSI MENU*\n\n` +
                                     `📌 *General & Utility*\n` +
                                     `• *.menu* : Menampilkan daftar menu\n` +
                                     `• *.ping* : Cek performa & status bot\n` +
                                     `• *.verify <username>* : Verifikasi TikTok\n` +
                                     `• *myinfo* : Cek info TikTok terverifikasi\n\n` +
                                     `👥 *Group Administration*\n` +
                                     `• *.kick* : Mengeluarkan member\n` +
                                     `• *.promote* : Menaikkan status ke Admin\n` +
                                     `• *.demote* : Menurunkan status dari Admin\n` +
                                     `• *.setwelcome <teks>* : Custom pesan welcome (@user)\n\n` +
                                     `⚙️ *Owner Settings*\n` +
                                     `• *.private* : Mode Khusus Owner\n` +
                                     `• *.publik* : Mode Semua Orang\n\n` +
                                     `*Status Bot saat ini:* [ ${isPublic ? 'Public' : 'Private'} ]`;
                    await sock.sendMessage(from, { text: menuText }, { quoted: msg });
                }

                // ------------------------------------------
                // 2. FITUR .PING
                // ------------------------------------------
                else if (command === '.ping') {
                    const startTime = Date.now();
                    const uptimeSec = process.uptime();
                    const hours = Math.floor(uptimeSec / 3600);
                    const minutes = Math.floor((uptimeSec % 3600) / 60);
                    const seconds = Math.floor(uptimeSec % 60);
                    
                    const latency = Date.now() - startTime;
                    const pingText = `🚀 *BOT STATUS & PING*\n\n` +
                                     `• *Kecepatan Respon:* ${latency} ms\n` +
                                     `• *Uptime Bot:* ${hours}j ${minutes}m ${seconds}s\n` +
                                     `• *Node.js Runtime:* ${process.version}\n` +
                                     `• *Platform Server:* ${process.platform}\n` +
                                     `• *Memory Usage:* ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
                    await sock.sendMessage(from, { text: pingText }, { quoted: msg });
                }

                // ------------------------------------------
                // 3. FITUR .VERIFY (TikTok Verification)
                // ------------------------------------------
                else if (command === '.verify') {
                    if (!args[0]) {
                        await sock.sendMessage(from, { text: '⚠️ Masukkan username TikTok kamu!\nContoh: *.verify akun_tiktok*' }, { quoted: msg });
                        return;
                    }

                    const tiktokUser = args[0].replace('@', '');
                    tiktokDb[senderNumber] = {
                        username: tiktokUser,
                        time: new Date().toLocaleString('id-ID')
                    };

                    const profileUrl = `https://www.tiktok.com/@${tiktokUser}`;
                    
                    const verifyText = `✅ *VERIFIKASI TIKTOK BERHASIL*\n\n` +
                                       `Akun TikTok *@${tiktokUser}* telah terhubung dengan nomor WhatsApp kamu.\n\n` +
                                       `🔗 *Profil TikTok:* ${profileUrl}\n\n` +
                                       `💡 *Tips:* Ketik *myinfo* untuk melihat detail status verifikasi kamu kapan saja.`;

                    await sock.sendMessage(from, { text: verifyText }, { quoted: msg });
                }

                // ------------------------------------------
                // 4. FITUR .PROMOTE
                // ------------------------------------------
                else if (command === '.promote') {
                    if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Khusus di dalam grup!' }, { quoted: msg });
                    if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Hanya Admin/Owner yang bisa menggunakan fitur ini!' }, { quoted: msg });
                    if (!isBotAdmin) return sock.sendMessage(from, { text: '❌ Bot harus menjadi Admin Grup terlebih dahulu!' }, { quoted: msg });
                    if (!targetUser) return sock.sendMessage(from, { text: '⚠️ Tag atau reply member yang ingin dijadikan Admin!' }, { quoted: msg });

                    await sock.groupParticipantsUpdate(from, [targetUser], 'promote');
                    await sock.sendMessage(from, { text: `✅ Berhasil menaikkan @${targetUser.split('@')[0]} menjadi Admin Grup!`, mentions: [targetUser] }, { quoted: msg });
                }

                // ------------------------------------------
                // 5. FITUR .DEMOTE
                // ------------------------------------------
                else if (command === '.demote') {
                    if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Khusus di dalam grup!' }, { quoted: msg });
                    if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Hanya Admin/Owner yang bisa menggunakan fitur ini!' }, { quoted: msg });
                    if (!isBotAdmin) return sock.sendMessage(from, { text: '❌ Bot harus menjadi Admin Grup terlebih dahulu!' }, { quoted: msg });
                    if (!targetUser) return sock.sendMessage(from, { text: '⚠️ Tag atau reply Admin yang ingin diturunkan!' }, { quoted: msg });

                    await sock.groupParticipantsUpdate(from, [targetUser], 'demote');
                    await sock.sendMessage(from, { text: `✅ Berhasil menurunkan @${targetUser.split('@')[0]} menjadi Member biasa.`, mentions: [targetUser] }, { quoted: msg });
                }

                // ------------------------------------------
                // 6. FITUR .SETWELCOME
                // ------------------------------------------
                else if (command === '.setwelcome') {
                    if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Khusus di dalam grup!' }, { quoted: msg });
                    if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Hanya Admin/Owner yang dapat mengatur teks Welcome!' }, { quoted: msg });
                    if (!args[0]) return sock.sendMessage(from, { text: '⚠️ Masukkan teks sambutan!\nGunakan tag *@user* untuk menyebut member baru.\n\nContoh: *.setwelcome Selamat datang @user di grup kami!*' }, { quoted: msg });

                    const customText = args.join(' ');
                    welcomeMessages[from] = customText;
                    await sock.sendMessage(from, { text: `✅ Teks pesan welcome untuk grup ini berhasil diperbarui!\n\n*Preview:* ${customText}` }, { quoted: msg });
                }

                // ------------------------------------------
                // 7. FITUR .PRIVATE
                // ------------------------------------------
                else if (command === '.private') {
                    if (!isOwner) return sock.sendMessage(from, { text: '❌ Fitur ini khusus Owner Bot!' }, { quoted: msg });
                    isPublic = false;
                    await sock.sendMessage(from, { text: '🔒 Status bot berhasil diubah menjadi *PRIVATE* (Hanya merespon Owner).' }, { quoted: msg });
                }

                // ------------------------------------------
                // 8. FITUR .PUBLIK
                // ------------------------------------------
                else if (command === '.publik') {
                    if (!isOwner) return sock.sendMessage(from, { text: '❌ Fitur ini khusus Owner Bot!' }, { quoted: msg });
                    isPublic = true;
                    await sock.sendMessage(from, { text: '🌐 Status bot berhasil diubah menjadi *PUBLIC* (Dapat digunakan semua orang).' }, { quoted: msg });
                }

                // ------------------------------------------
                // 9. FITUR .KICK
                // ------------------------------------------
                else if (command === '.kick') {
                    if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Khusus di dalam grup!' }, { quoted: msg });
                    if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Hanya Admin Grup dan Owner yang diizinkan menggunakan perintah ini!' }, { quoted: msg });
                    if (!isBotAdmin) return sock.sendMessage(from, { text: '❌ Bot harus dijadikan *Admin Grup* terlebih dahulu.' }, { quoted: msg });
                    if (!targetUser) return sock.sendMessage(from, { text: '⚠️ Tag, reply, atau masukkan nomor member yang ingin dikeluarkan!' }, { quoted: msg });

                    try {
                        await sock.groupParticipantsUpdate(from, [targetUser], 'remove');
                        await sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan @${targetUser.split('@')[0]} dari grup.`, mentions: [targetUser] }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(from, { text: `❌ Gagal mengeluarkan user. Pastikan nomor valid atau bot memiliki hak akses.` }, { quoted: msg });
                    }
                }

            } catch (err) {
                console.error(`Error pada command handler:`, err);
            }
        }
    });
}

startBot();
