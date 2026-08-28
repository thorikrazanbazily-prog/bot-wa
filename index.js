import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    generateWAMessageFromContent, 
    proto 
} from '@whiskeysockets/baileys';
import { pino } from 'pino';
import readline from 'readline';

const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(text, (ans) => { rl.close(); resolve(ans); }));
};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false // Menggunakan pairing code agar lebih mudah di Termux
    });

    // Jika belum ada session, gunakan pairing code nomor WhatsApp
    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('Masukkan nomor WhatsApp Anda (contoh: 628xxxxxxxxxx): ');
        const code = await sock.requestPairingCode(phoneNumber.trim());
        console.log(`Kode Pairing WhatsApp Anda: ${code}`);
    }

    sock.connection.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, mencoba menghubungkan ulang...', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Bot WhatsApp berhasil terhubung!');
        }
    });

    // Mendengarkan pesan masuk
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;
            
            // Mengabaikan pesan dari status atau bot sendiri
            if (mek.key.fromMe) return;

            const jid = mek.key.remoteJid;
            
            // Mendapatkan teks pesan masuk (baik pesan teks biasa maupun balasan klik tombol)
            const type = Object.keys(mek.message)[0];
            let bodyText = '';

            if (type === 'conversation') {
                bodyText = mek.message.conversation;
            } else if (type === 'extendedTextMessage') {
                bodyText = mek.message.extendedTextMessage.text;
            } else if (type === 'interactiveResponseMessage') {
                // Menangkap respons saat tombol diklik oleh pengguna
                const response = mek.message.interactiveResponseMessage;
                if (response.nativeFlowResponseMessage) {
                    const paramsJson = JSON.parse(response.nativeFlowResponseMessage.paramsJson);
                    bodyText = paramsJson.id; // Mengambil ID tombol yang dikirim
                }
            }

            const command = bodyText.trim().toLowerCase();

            // 1. Perintah untuk memunculkan tombol interaktif
            if (command === '.menu' || command === 'menu') {
                const buttonMessage = generateWAMessageFromContent(jid, {
                    viewOnceMessage: {
                        message: {
                            interactiveMessage: {
                                body: { text: "Halo! Silakan pilih salah satu opsi menu di bawah ini:" },
                                footer: { text: "Powered by Baileys & Node.js" },
                                nativeFlowMessage: {
                                    buttons: [
                                        {
                                            name: "quick_reply",
                                            buttonParamsJson: JSON.stringify({
                                                display_text: "Info Bot",
                                                id: "btn_info"
                                            })
                                        },
                                        {
                                            name: "quick_reply",
                                            buttonParamsJson: JSON.stringify({
                                                display_text: "Kontak Owner",
                                                id: "btn_owner"
                                            })
                                        }
                                    ]
                                }
                            }
                        }
                    }
                }, {});

                await sock.relayMessage(jid, buttonMessage.message, { messageId: buttonMessage.key.id });
            }

            // 2. Menangani aksi berdasarkan tombol yang diklik
            else if (command === 'btn_info') {
                await sock.sendMessage(jid, { text: "Bot ini berjalan menggunakan Node.js dan Baileys versi terbaru!" }, { quoted: mek });
            } 
            else if (command === 'btn_owner') {
                await sock.sendMessage(jid, { text: "Silakan hubungi pemilik bot melalui nomor utama." }, { quoted: mek });
            }

        } catch (error) {
            console.error('Terjadi kesalahan pada handler pesan:', error);
        }
    });
}

startBot();
