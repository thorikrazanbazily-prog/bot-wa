const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('Scan QR Code di bawah ini menggunakan WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Koneksi terputus, mencoba menghubungkan ulang...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp Berhasil Terhubung dan Siap Digunakan!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;

            const from = msg.key.remoteJid;
            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || '';

            if (!text) return;
            
            console.log(`Pesan dari ${from}: ${text}`);

            const command = text.trim().toLowerCase();

            if (command === '.menu' || command === '.popup' || command === '.button') {
                await sock.sendMessage(from, {
                    text: "✨ *MENU PILIHAN FORMAT NAMA* ✨\n\nSilakan pilih opsi di bawah ini:\n\n1. K– Angga\n2. 水 Angga\n3. Angga Kaguya"
                }, { quoted: msg });
            }
        } catch (error) {
            console.log("Terjadi kesalahan pada handler pesan:", error);
        }
    });
}

connectToWhatsApp();
