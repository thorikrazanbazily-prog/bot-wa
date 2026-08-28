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
            const sections = [
                {
                    title: "Pilih Opsi Nama / Teks",
                    rows: [
                        { title: "K– Angga", rowId: "opt_1", description: "Salin format K– Angga" },
                        { title: "水 Angga", rowId: "opt_2", description: "Salin format 水 Angga" },
                        { title: "Angga 水", rowId: "opt_3", description: "Salin format Angga 水" },
                        { title: "Angga ft KGY", rowId: "opt_4", description: "Salin format Angga ft KGY" },
                        { title: "Angga Kaguya", rowId: "opt_5", description: "Salin format Angga Kaguya" }
                    ]
                }
            ];

            const listMessage = {
                text: "✨ *SILAKAN PILIH FORMAT DI BAWAH* ✨\n\nKlik tombol menu untuk menampilkan daftar opsi pilihan teks:",
                footer: "Bot Riq Imup",
                title: "Daftar Pilihan",
                buttonText: "Klik Disini",
                sections
            };

            await sock.sendMessage(from, listMessage, { quoted: msg });
        }
    });
}

connectToWhatsApp();
