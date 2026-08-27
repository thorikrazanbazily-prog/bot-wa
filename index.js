const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// LIST NOMOR OWNER (Ganti dengan nomormu)
const ownerNumber = ['6281298697777'];

// LIST NOMOR YANG DIIZINKAN MENGGUNAKAN FITUR .KICK (Selain Owner)
// Masukkan nomor dengan awalan 62 tanpa tanda + atau spasi
const allowedKickUsers = [
    '6281234567890', // Contoh nomor 1 yang boleh kick
    '6289876543210'  // Contoh nomor 2 yang boleh kick (tambahkan atau hapus sesuai kebutuhan)
];

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

                const rawSender = msg.key.participant || msg.participant || msg.key.remoteJid || '';
                const senderNumber = rawSender.split('@')[0].replace(/[^0-9]/g, '');
                const isOwner = ownerNumber.includes(senderNumber) || msg.key.fromMe;

                // Pengecekan apakah pengirim ada di daftar yang diizinkan menggunakan kick
                const isAllowedKick = allowedKickUsers.includes(senderNumber);

                const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                const pesan = body.trim();
                if (!pesan.startsWith('.')) continue;

                const command = pesan.toLowerCase().split(' ')[0];
                const args = pesan.split(' ').slice(1);

                // ==========================================
                // FITUR .KICK (Hanya User Pilihan, Admin, & Owner)
                // ==========================================
                if (command === '.kick') {
                    if (!isGroup) {
                        await sock.sendMessage(from, { text: '⚠️ Fitur ini khusus di dalam grup!' }, { quoted: msg });
                        return;
                    }

                    // Validasi: Hanya Owner, atau User dalam daftar izin, atau Admin Grup yang boleh pakai
                    const groupMetadata = await sock.groupMetadata(from);
                    const participants = groupMetadata.participants;
                    
                    const participant = participants.find(p => p.id === rawSender || p.id.split('@')[0] === senderNumber);
                    const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

                    if (!isOwner && !isAllowedKick && !isAdmin) {
                        await sock.sendMessage(from, { text: '❌ Maaf, kamu tidak memiliki izin untuk menggunakan perintah ini!' }, { quoted: msg });
                        return;
                    }

                    const botJid = sock.user?.id || '';
                    const botNumber = botJid.split(':')[0].replace(/[^0-9]/g, '');

                    const botPart = participants.find(p => p.id.replace(/[^0-9]/g, '').includes(botNumber));
                    const isBotAdmin = botPart && (botPart.admin === 'admin' || botPart.admin === 'superadmin');

                    if (!isBotAdmin) {
                        await sock.sendMessage(from, { text: '❌ Gagal! Bot harus dijadikan *Admin Grup* terlebih dahulu.' }, { quoted: msg });
                        return;
                    }

                    const quoted = msg.message.extendedTextMessage?.contextInfo;
                    let targetUser = quoted?.mentionedJid?.[0] || quoted?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
                    
                    if (!targetUser) {
                        await sock.sendMessage(from, { text: '⚠️ Silakan tag, reply, atau masukkan nomor orang yang ingin dikeluarkan dari grup!' }, { quoted: msg });
                        return;
                    }

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
