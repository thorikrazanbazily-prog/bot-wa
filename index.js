const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: true
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

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            // Pastikan mengambil objek pesan dengan aman dari chatUpdate.messages
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;

            // Jika pesan berasal dari status / broadcast, abaikan
            if (mek.key.remoteJid === 'status@broadcast') return;

            const from = mek.key.remoteJid;
            
            // Ekstraksi teks dari berbagai jenis tipe pesan masuk
            const messageType = Object.keys(mek.message)[0];
            let text = '';

            if (messageType === 'conversation') {
                text = mek.message.conversation;
            } else if (messageType === 'extendedTextMessage') {
                text = mek.message.extendedTextMessage.text;
            } else if (messageType === 'imageMessage') {
                text = mek.message.imageMessage.caption;
            }

            if (!text) return;

            console.log(`📩 Pesan masuk dari ${from}: ${text}`);

            const command = text.trim().toLowerCase();

            // Cek perintah .menu, .button, atau .popup
            if (command === '.menu' || command === '.button' || command === '.popup') {
                await sock.sendMessage(from, {
                    text: "✨ *MENU UTAMA BOT* ✨\n\nSilakan pilih salah satu opsi di bawah ini dengan mengetik balasannya:\n\n1. K– Angga\n2. 水 Angga\n3. Angga Kaguya"
                }, { quoted: mek });
                console.log("✅ Berhasil mengirim balasan menu ke:", from);
            }
        } catch (err) {
            console.error("❌ Terjadi error pada handler pesan:", err);
        }
    });
}

connectToWhatsApp();
