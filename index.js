const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
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
            console.log('✅ Bot WhatsApp dengan fitur Button SIAP DIGUNAKAN!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || '';

        if (!text) return;
        const command = text.trim().toLowerCase();

        // ==========================================
        // PERINTAH UNTUK MENAMPILKAN TOMBOL (.button)
        // ==========================================
        if (command === '.menu' || command === '.popup' || command === '.button') {
            await sock.sendMessage(from, {
                text: "✨ *MENU POP-UP INTERAKTIF* ✨\n\nSilakan pilih salah satu opsi di bawah ini:",
                footer: "Bot Riq Imup",
                buttons: [
                    {
                        buttonId: "opt_1",
                        buttonText: { displayText: "📋 K– Angga" },
                        type: 1
                    },
                    {
                        buttonId: "opt_2",
                        buttonText: { displayText: "📋 水 Angga" },
                        type: 1
                    },
                    {
                        buttonId: "opt_3",
                        buttonText: { displayText: "📋 Angga Kaguya" },
                        type: 1
                    }
                ],
                headerType: 1
            }, { quoted: msg });
        }
    });
}

connectToWhatsApp();
