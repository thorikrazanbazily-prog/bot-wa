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
         if (command === '.button' || command === '.menu') {
            await sock.sendMessage(from, {
                text: "✨ *MENU PESAN INTERAKTIF* ✨\n\nSilakan pilih salah satu opsi tombol di bawah ini:",
                footer: "Bot Riq Imup",
                buttons: [
                    {
                        name: "cta_copy",
                        buttonParamsJson: JSON.stringify({
                            display_text: "📋 Salin Kode Voucher",
                            id: "copy_voucher_1",
                            copy_code: "RIQIMUP2026"
                        })
                    },
                    {
                        name: "cta_url",
                        buttonParamsJson: JSON.stringify({
                            display_text: "🌐 Kunjungi Website",
                            id: "url_btn",
                            url: "https://whatsapp.com"
                        })
                    }
                ]
            }, { quoted: msg });
        }
    });
}

connectToWhatsApp();
