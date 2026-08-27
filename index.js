const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// LIST NOMOR OWNER / YANG DIIZINKAN (Ganti dengan nomor kamu, awalan 62)
const ownerNumber = ['6281298697777'];

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

                const body = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || '';
                
                const pesan = body.trim();
                if (!pesan.startsWith('.')) continue;

                const command = pesan.toLowerCase().split(' ')[0];

                // FITUR .KICK (Khusus Admin Grup & Owner)
                if (command === '.kick') {
                    if (!isGroup) {
                        await sock.sendMessage(from, { text: '⚠️ Fitur ini khusus di dalam grup!' }, { quoted: msg });
                        return;
                    }

                    const groupMetadata = await sock.groupMetadata(from);
                    const participants = groupMetadata.participants;
                    
                    const participant = participants.find(p => p.id === rawSender || p.id.split('@')[0] === senderNumber);
                    const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

                    if (!isAdmin && !isOwner) {
                        await sock.sendMessage(from, { text: '❌ Perintah ini hanya dapat digunakan oleh *Admin Grup*!' }, { quoted: msg });
                        return;
                    }

                    const botJid = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
                    const botPart = participants.find(p => p.id === botJid || p.id === sock.user.id || p.id.startsWith(sock.user.id.split('@')[0]));
                    const isBotAdmin = botPart && (botPart.admin === 'admin' || botPart.admin === 'superadmin');

                    if (!isBotAdmin) {
                        await sock.sendMessage(from, { text: '❌ Gagal! Bot harus dijadikan *Admin Grup* terlebih dahulu.' }, { quoted: msg });
                        return;
                    }

                    let targetUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || msg.message.extendedTextMessage?.contextInfo?.participant;
                    
                    if (!targetUser) {
                        await sock.sendMessage(from, { text: '⚠️ Silakan tag atau reply orang yang ingin dikeluarkan dari grup!' }, { quoted: msg });
                        return;
                    }

                    await sock.groupParticipantsUpdate(from, [targetUser], 'remove');
                    await sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan @${targetUser.split('@')[0]} dari grup.`, mentions: [targetUser] }, { quoted: msg });
                }

            } catch (err) {
                console.error(`Error pada command handler:`, err);
            }
        }
    });
}

startBot();
