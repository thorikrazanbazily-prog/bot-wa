import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import FormData from 'form-data';
import ffmpeg from 'fluent-ffmpeg';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';

// ==========================================
// KONFIGURASI OWNER & VIP
// ==========================================
const ownerNumbers = ['6281298697777']; // Nomor Owner Anda
const vipNumbers = []; // Tambahkan nomor VIP jika ada (format string: '628xxxxxxxx')

// ==========================================
// FILE LOKAL DATABASE KONTROL & SETTINGAN
// ==========================================
const CONTROL_FILE = 'bot_control.json';
const SETTINGS_FILE = 'bot_settings.json';
const DB_RPG_FILE = 'rpg.json';
const WELCOME_SETTINGS_FILE = 'welcome_settings.json';

// Helper load & save kontrol bot (private/public & whitelist gc)
const loadBotControl = () => {
    try {
        if (fs.existsSync(CONTROL_FILE)) {
            return JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Gagal membaca bot_control.json:', e);
    }
    return { isPrivate: false, allowedGroups: [] };
};

const saveBotControl = (control) => {
    try {
        fs.writeFileSync(CONTROL_FILE, JSON.stringify(control, null, 2));
    } catch (e) {
        console.error('Gagal menyimpan bot_control.json:', e);
    }
};

// ==========================================
// FUNGSI HELPER PEMBUAT STIKER (FFMPEG)
// ==========================================
async function makeSticker(mediaBuffer, mimeType) {
    let ext = mimeType && mimeType.includes('video') ? 'mp4' : 'jpg';
    let tmpFileIn = join(tmpdir(), `${Date.now()}.${ext}`);
    let tmpFileOut = join(tmpdir(), `${Date.now()}.webp`);
    
    await writeFile(tmpFileIn, mediaBuffer);
    
    await new Promise((resolve, reject) => {
        ffmpeg(tmpFileIn)
            .input(tmpFileIn)
            .on('error', (err) => reject(err))
            .on('end', () => resolve(true))
            .addOutputOptions([
                "-vcodec", "libwebp",
                "-vf", "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
                "-loop", "0",
                "-ss", "00:00:00",
                "-t", "00:00:05",
                "-preset", "default",
                "-an",
                "-vsync", "0"
            ])
            .toFormat('webp')
            .save(tmpFileOut);
    });

    let stickerBuffer = await fs.promises.readFile(tmpFileOut);
    await unlink(tmpFileIn);
    await unlink(tmpFileOut);
    return stickerBuffer;
}

// ==========================================
// CACHE & DATABASE CONFIG
// ==========================================

// CACHE RAM MEMORI UNTUK RESPON GRUP CEPAT (ANTI-DELAY)
const groupMembersCache = {};

// Helper presisi mengekstrak digit angka saja
const extractNumber = (jid) => {
    if (!jid || typeof jid !== 'string') return '';
    const clean = jid.split('@')[0].split(':')[0];
    return clean.replace(/[^0-9]/g, '');
};

// HELPER CACHE METADATA GRUP
async function getGroupMetadataCached(sock, groupId) {
    const now = Date.now();
    if (groupMembersCache[groupId] && (now - groupMembersCache[groupId].lastFetch < 300000)) {
        return groupMembersCache[groupId].metadata;
    }
    const metadata = await sock.groupMetadata(groupId).catch(() => null);
    if (metadata) {
        groupMembersCache[groupId] = {
            metadata: metadata,
            lastFetch: now
        };
    }
    return metadata;
}

const loadRpgDb = () => {
    try {
        if (fs.existsSync(DB_RPG_FILE)) {
            return JSON.parse(fs.readFileSync(DB_RPG_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Gagal membaca database RPG:', e);
    }
    return {};
};

const saveRpgDb = (db) => {
    try {
        fs.writeFileSync(DB_RPG_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error('Gagal menyimpan database RPG:', e);
    }
};

const loadWelcomeSettings = () => {
    try {
        if (fs.existsSync(WELCOME_SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(WELCOME_SETTINGS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Gagal membaca database welcome:', e);
    }
    return {};
};

const saveWelcomeSettings = (settings) => {
    try {
        fs.writeFileSync(WELCOME_SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('Gagal menyimpan database welcome:', e);
    }
};

async function uploadToCatbox(buffer, filename = 'file.jpg') {
    try {
        const formData = new FormData();
        formData.append('reqtype', 'fileupload');
        formData.append('fileToUpload', buffer, { filename: filename });
        
        const res = await fetch('https://catbox.moe/user/api.php', {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders()
        });
        const resultUrl = await res.text();
        return resultUrl.trim();
    } catch (err) {
        console.error('Gagal upload ke Catbox:', err);
        return null;
    }
}

// ==========================================
// KONEKSI UTAMA BOT
// ==========================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        auth: state,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        emitOwnEvents: true, 
        retryRequestDelayMs: 250
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log('📌 QR Code baru berhasil dibuat, silakan scan:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'connecting') {
            console.log('🔄 Menghubungkan ke server WhatsApp...');
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Koneksi terputus (Status: ${statusCode}). Mencoba menghubungkan kembali...`);
            
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('❌ Terlogout dari WhatsApp. Silakan hapus folder baileys_auth_info lalu restart.');
            }
        } else if (connection === 'open') {
            console.log('✅ Bot berhasil terhubung ke WhatsApp!');
        }
    }); 

    // ==========================================
    // LISTENER WELCOME MEMBER BARU
    // ==========================================
    sock.ev.on('group-participants.update', async (anu) => {
        try {
            const { id: groupId, participants, action } = anu;
            if (action !== 'add') return;

            let welcomeSettings = loadWelcomeSettings();
            if (!welcomeSettings[groupId] || !welcomeSettings[groupId].enabled) return;

            let customText = welcomeSettings[groupId].text || 'Halo @user, selamat datang di @subject!';
            const groupMetadata = await getGroupMetadataCached(sock, groupId);
            const groupName = groupMetadata ? groupMetadata.subject : 'Grup ini';

            for (let num of participants) {
                const jid = typeof num === 'string' ? num : (num.id || num.jid || '');
                if (!jid) continue;

                const numericId = jid.split('@')[0];
                const userTag = `@${numericId}`;
                
                let finalWelcome = customText
                    .replace(/@user/g, userTag)
                    .replace(/@subject/g, groupName);

                await sock.sendMessage(groupId, {
                    text: finalWelcome,
                    mentions: [jid]
                });
            }
        } catch (err) {
            console.error('Error Group Participants Update:', err);
        }
    });

    // ==========================================
    // LISTENER PESAN MASUK (messages.upsert)
    // ==========================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (!m.messages || m.messages.length === 0) return;
            const msg = m.messages[0];
            
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            await sock.readMessages([msg.key]).catch(() => {});

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const senderJid = isGroup ? (msg.key.participant || from) : from;
            const senderNumber = extractNumber(senderJid);

            // Cek Hak Akses Owner & VIP
            const isOwner = ownerNumbers.includes(senderNumber);
            const isVip = vipNumbers.includes(senderNumber);
            const isOwnerOrVip = isOwner || isVip;

            // Kontrol Bot (Private / Public / Whitelist GC)
            const botControl = loadBotControl();
            if (botControl.isPrivate && !isOwnerOrVip) {
                if (isGroup) {
                    // Jika mode private, cek apakah grup ini di-whitelist
                    if (!botControl.allowedGroups.includes(from)) return;
                } else {
                    // Jika di chat pribadi dan bukan owner/vip, abaikan
                    return;
                }
            }

            const messageContent = msg.message.ephemeralMessage?.message || 
                                   msg.message.viewOnceMessage?.message || 
                                   msg.message.viewOnceMessageV2?.message || 
                                   msg.message;

            let body = '';
            const type = Object.keys(messageContent)[0];

            if (type === 'conversation') {
                body = messageContent.conversation;
            } else if (type === 'extendedTextMessage') {
                body = messageContent.extendedTextMessage.text;
            } else if (type === 'imageMessage') {
                body = messageContent.imageMessage.caption;
            } else if (type === 'videoMessage') {
                body = messageContent.videoMessage.caption;
            }

            const text = body || '';
            const args = text.trim().split(/ +/);
            const command = args.length > 0 ? args.shift().toLowerCase() : '';
            const textInput = args.join(' ');

            // ==========================================
            // FITUR KONTROL OWNER & VIP (.private, .public, .addgc, .delgc)
            // ==========================================
            if (['.private', '.public', '.addgc', '.delgc'].includes(command)) {
                if (!isOwnerOrVip) {
                    return sock.sendMessage(from, { text: '❌ Perintah ini khusus untuk *Owner* dan *VIP*!' }, { quoted: msg });
                }

                let control = loadBotControl();

                if (command === '.private') {
                    control.isPrivate = true;
                    saveBotControl(control);
                    await sock.sendMessage(from, { text: '🔒 Bot berhasil diubah ke mode *PRIVATE* (Hanya Owner/VIP & Grup yang di-whitelist).' }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } 
                else if (command === '.public') {
                    control.isPrivate = false;
                    saveBotControl(control);
                    await sock.sendMessage(from, { text: '🔓 Bot berhasil diubah ke mode *PUBLIC* (Dapat digunakan oleh siapa saja).' }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } 
                else if (command === '.addgc') {
                    if (!isGroup) {
                        return sock.sendMessage(from, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    }
                    if (control.allowedGroups.includes(from)) {
                        return sock.sendMessage(from, { text: '⚠️ Grup ini sudah terdaftar dalam akses bot.' }, { quoted: msg });
                    }
                    control.allowedGroups.push(from);
                    saveBotControl(control);
                    await sock.sendMessage(from, { text: '✅ Grup ini berhasil diberikan akses (whitelist) untuk menggunakan bot!' }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } 
                else if (command === '.delgc') {
                    if (!isGroup) {
                        return sock.sendMessage(from, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    }
                    const index = control.allowedGroups.indexOf(from);
                    if (index === -1) {
                        return sock.sendMessage(from, { text: '⚠️ Grup ini tidak ada dalam daftar izin bot.' }, { quoted: msg });
                    }
                    control.allowedGroups.splice(index, 1);
                    saveBotControl(control);
                    await sock.sendMessage(from, { text: '❌ Akses grup ini telah dicabut dari bot.' }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                }
            }

            // MENU & PING
            else if (command === '.menu' || command === '.help') {
                const menuText = 
`😳 *BOT RIQ IMUP* 😳

👑 *OWNER & VIP TOOLS*
* ➔ *.private* : Batasi bot hanya untuk Owner/VIP & GC whitelist
* ➔ *.public* : Buka bot untuk umum
* ➔ *.addgc* : Beri akses bot ke grup ini
* ➔ *.delgc* : Cabut akses bot dari grup ini

📌 *PERINTAH UTAMA*
* ➔ *.menu* : Menampilkan menu
* ➔ *.ping* : Cek kecepatan respon bot

📥 *DOWNLOADER & MEDIA*
* ➔ *.tiktok / .tt <link>* : Download video TikTok tanpa watermark
* ➔ *.ytmp3 <link>* : Download audio YouTube MP3
* ➔ *.ig / .instagram <link>* : Download video Reel/Post Instagram

🎨 *STIKER & TOOLS MEDIA*
* ➔ *.stiker* / *.s* : Kirim/reply foto jadi stiker
* ➔ *.wm <pack> | <author>* : Ubah watermark stiker
* ➔ *.smeme <atas> | <bawah>* : Buat stiker meme dengan teks
* ➔ *.tts <teks>* : Ubah teks jadi Voice Note (Suara Google)
* ➔ *.pinterest <kata kunci>* : Cari foto estetik dari Pinterest
* ➔ *.short <link>* : Memperpendek URL/link panjang
* ➔ *.rvo* : Reply foto/video sekali lihat (view once)

👋 *FITUR WELCOME (SELAMAT DATANG)*
* ➔ *.on welcome* : Menghidupkan fitur sambutan member baru
* ➔ *.off welcome* : Mematikan fitur sambutan member baru
* ➔ *.setwelcome <teks>* : Mengatur teks sambutan (Gunakan *@user* dan *@subject*)

👥 *GRUP & MANAJEMEN*
* ➔ *.ah <pesan> / reply* : Hidetag (Mention seluruh member)
* ➔ *.masukin <nomor>* : Menambahkan member ke grup
* ➔ *.ewein @user* : Mencopot/mengeluarkan member dari grup
* ➔ *.promote / .demote @user* : Atur admin grup

⚔️ *GAME RPG*
* ➔ *.rpg* / *.status* / *.profile* : Cek profil karakter RPG
* ➔ *.pilihjob <warrior/mage/archer>* : Memilih job karakter
* ➔ *.adventure* / *.hunt* : Berburu monster & cari EXP/Gold
* ➔ *.heal* : Memulihkan HP karakter
* ➔ *.leaderboard* / *.toprpg* : Peringkat pemain RPG teratas`;

                await sock.sendMessage(from, { text: menuText }, { quoted: msg });
                await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
            } 
            else if (command === '.ping') {
                const start = Date.now();
                const usedMemory = process.memoryUsage();
                const formatMemory = (bytes) => (bytes / 1024 / 1024).toFixed(2);
                
                const uptime = process.uptime();
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);
                const uptimeString = `${hours}j ${minutes}m ${seconds}d`;

                const latency = Date.now() - start;

                const pingText = 
`🏓 *PONG!*

⚡ *Kecepatan Respon:* ${latency} ms
⏱️ *Uptime Bot:* ${uptimeString}
💻 *Platform:* ${process.platform} (${process.arch})
🤖 *Status Bot:* ${botControl.isPrivate ? '🔒 Private' : '🔓 Public'}

📊 *Penggunaan Memori (RAM):*
• RSS: ${formatMemory(usedMemory.rss)} MB
• Heap Total: ${formatMemory(usedMemory.heapTotal)} MB
• Heap Used: ${formatMemory(usedMemory.heapUsed)} MB`;

                await sock.sendMessage(from, { text: pingText }, { quoted: msg });
                await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
            }

            // INSTAGRAM DOWNLOADER
            else if (command === '.ig' || command === '.instagram') {
                if (!textInput) {
                    return sock.sendMessage(from, { text: '⚠️ Masukkan link Instagram!\nContoh: *.ig https://www.instagram.com/reel/...*' }, { quoted: msg });
                }
                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });
                try {
                    const res = await fetch(`https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(textInput)}`).then(r => r.json()).catch(() => null);
                    if (res && res.status && res.data && res.data.length > 0) {
                        for (let item of res.data) {
                            const mediaUrl = item.url;
                            if (mediaUrl.includes('.mp4')) {
                                await sock.sendMessage(from, { video: { url: mediaUrl }, caption: '🎬 *INSTAGRAM DOWNLOADER*' }, { quoted: msg });
                            } else {
                                await sock.sendMessage(from, { image: { url: mediaUrl }, caption: '📸 *INSTAGRAM DOWNLOADER*' }, { quoted: msg });
                            }
                        }
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } else {
                        throw new Error('Data Instagram tidak ditemukan.');
                    }
                } catch (err) {
                    console.error('Error IG:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengunduh media Instagram. Pastikan link publik dan valid!' }, { quoted: msg });
                }
            }

            // TEXT TO SPEECH
            else if (command === '.tts' || command === '.vn') {
                if (!textInput) {
                    return sock.sendMessage(from, { text: '⚠️ Masukkan teks!\nContoh: *.tts Halo selamat pagi semuanya*' }, { quoted: msg });
                }
                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });
                try {
                    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(textInput)}&tl=id&client=tw-ob`;
                    await sock.sendMessage(from, { audio: { url: ttsUrl }, mimetype: 'audio/mp4', ptt: true }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } catch (err) {
                    console.error('Error TTS:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengubah teks menjadi suara.' }, { quoted: msg });
                }
            }

            // PINTEREST SEARCH
            else if (command === '.pinterest' || command === '.pin') {
                if (!textInput) {
                    return sock.sendMessage(from, { text: '⚠️ Masukkan kata kunci gambar!\nContoh: *.pinterest wallpaper estetik*' }, { quoted: msg });
                }
                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });
                try {
                    const apis = [
                        `https://api.siputzx.my.id/api/s/pinterest?query=${encodeURIComponent(textInput)}`,
                        `https://itzpire.com/search/pinterest?query=${encodeURIComponent(textInput)}`
                    ];
                    
                    let imageUrl = null;
                    for (let apiUrl of apis) {
                        try {
                            const response = await fetch(apiUrl);
                            const res = await response.json();
                            if (res && (res.status || res.code === 200) && res.data) {
                                const list = Array.isArray(res.data) ? res.data : (res.data.result || res.data);
                                if (list && list.length > 0) {
                                    const randItem = list[Math.floor(Math.random() * list.length)];
                                    imageUrl = typeof randItem === 'string' ? randItem : (randItem.images_url || randItem.url || randItem.link);
                                    if (imageUrl) break;
                                }
                            }
                        } catch (e) {
                            continue;
                        }
                    }

                    if (imageUrl) {
                        await sock.sendMessage(from, { image: { url: imageUrl }, caption: `📌 *PINTEREST SEARCH*\n🔍 *Query:* ${textInput}` }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } else {
                        throw new Error('Gambar Pinterest tidak ditemukan.');
                    }
                } catch (err) {
                    console.error('Error Pinterest:', err);
                    await sock.sendMessage(from, { text: '❌ Gambar tidak ditemukan atau server API sedang sibuk.' }, { quoted: msg });
                }
            }

            // STIKER MEME (SMEME)
            else if (command === '.smeme' || command === '.memesticker') {
                try {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const qMsg = contextInfo?.quotedMessage;
                    const isDirectImage = msg.message.imageMessage;
                    
                    let quotedImageMsg = qMsg?.imageMessage || 
                                         qMsg?.ephemeralMessage?.message?.imageMessage || 
                                         qMsg?.viewOnceMessage?.message?.imageMessage ||
                                         qMsg?.viewOnceMessageV2?.message?.imageMessage;

                    if (!isDirectImage && !quotedImageMsg) {
                        return sock.sendMessage(from, { text: '⚠️ Kirim atau reply foto dengan format:\n*.smeme <teks atas>* atau\n*.smeme <teks atas> | <teks bawah>*' }, { quoted: msg });
                    }

                    if (!textInput) {
                        return sock.sendMessage(from, { text: '⚠️ Masukkan teks meme-nya!\nContoh: *.smeme Teks Atas | Teks Bawah*' }, { quoted: msg });
                    }

                    await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });

                    let mediaTarget = msg;
                    if (quotedImageMsg) {
                        mediaTarget = {
                            key: { remoteJid: from, fromMe: false, id: contextInfo.stanzaId, participant: contextInfo.participant || from },
                            message: qMsg
                        };
                    }

                    let mediaBuffer = await downloadMediaMessage(mediaTarget, 'buffer', {});
                    if (!mediaBuffer || mediaBuffer.length === 0) throw new Error('Gagal mendownload media.');

                    let imageUrl = await uploadToCatbox(mediaBuffer, 'meme.jpg');
                    if (!imageUrl || !imageUrl.startsWith('http')) {
                        return sock.sendMessage(from, { text: '❌ Gagal mengunggah media sementara.' }, { quoted: msg });
                    }

                    let topText = '';
                    let bottomText = '';

                    if (textInput.includes('|')) {
                        let parts = textInput.split('|').map(s => s.trim());
                        topText = parts[0] || '';
                        bottomText = parts[1] || '';
                    } else {
                        topText = textInput;
                        bottomText = '';
                    }

                    let memeApiUrl = `https://api.siputzx.my.id/api/maker/meme?url=${encodeURIComponent(imageUrl)}&text1=${encodeURIComponent(topText)}&text2=${encodeURIComponent(bottomText)}`;
                    let memeRes = await fetch(memeApiUrl);
                    if (!memeRes.ok) throw new Error(`Gagal merender meme (Status: ${memeRes.status})`);
                    
                    let memeBuffer = Buffer.from(await memeRes.arrayBuffer());
                    let stickerBuffer = await makeSticker(memeBuffer, 'image/jpeg');

                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                } catch (err) {
                    console.error('Error Smeme:', err);
                    await sock.sendMessage(from, { text: `❌ Gagal merender gambar meme.` }, { quoted: msg });
                }
            }

            // BUTTON CN
            else if (command === '.cn') {
                let query = textInput || 'riq ganteng';
                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });

                try {
                    await sock.relayMessage(
                        from,
                        {
                            "interactiveMessage": {
                                "body": { "text": `haii ${query}` },
                                "footer": { "text": "CN Generator | riq" },
                                "nativeFlowMessage": {
                                    "buttons": [
                                        {
                                            "name": "cta_copy",
                                            "buttonParamsJson": JSON.stringify({
                                                "display_text": "CN !",
                                                "copy_code": `水 ${query}`
                                            })
                                        }
                                    ],
                                    "messageParamsJson": "{}"
                                }
                            }
                        },
                        {
                            quoted: msg,
                            "additionalNodes": [
                                {
                                    "tag": "biz",
                                    "attrs": {},
                                    "content": [
                                        {
                                            "tag": "interactive",
                                            "attrs": { "type": "native_flow", "v": "1" },
                                            "content": [
                                                {
                                                    "tag": "native_flow",
                                                    "attrs": { "v": "9", "name": "mixed" }
                                                }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        }
                    );
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } catch (err) {
                    console.error('Error Relay Message CTA Copy:', err);
                    await sock.sendMessage(from, { text: `❌ Gagal mengirim pesan interaktif.` }, { quoted: msg });
                }
            }

            // SHORT LINK
            else if (command === '.short' || command === '.shortlink' || command === '.tinyurl') {
                if (!textInput) {
                    return sock.sendMessage(from, { text: '⚠️ Masukkan URL!\nContoh: *.short https://google.com*' }, { quoted: msg });
                }
                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });
                try {
                    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(textInput)}`).then(r => r.text());
                    if (res && res.startsWith('http')) {
                        await sock.sendMessage(from, { text: `🔗 *SHORT LINK*\n\n*Hasil:* ${res}` }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } else {
                        throw new Error('Format link tidak valid.');
                    }
                } catch (err) {
                    console.error('Error Shortlink:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal memperpendek link.' }, { quoted: msg });
                }
            }

            // TIKTOK DOWNLOADER
            else if (command === '.tiktok' || command === '.tt') {
                if (!textInput) {
                    return sock.sendMessage(from, { text: '⚠️ Masukkan link TikTok!\nContoh: *.tiktok https://vt.tiktok.com/...*' }, { quoted: msg });
                }
                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });
                try {
                    const response = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(textInput)}`);
                    const res = await response.json();
                    if (res.code === 0 && res.data) {
                        const videoUrl = res.data.play;
                        const title = res.data.title || 'TikTok Video';
                        await sock.sendMessage(from, { video: { url: videoUrl }, caption: `🎬 *TIKTOK DOWNLOADER*\n\n📝 *Judul:* ${title}` }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } else {
                        throw new Error('Gagal mengambil data dari TikTok.');
                    }
                } catch (err) {
                    console.error('Error TikTok:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengunduh video TikTok. Pastikan link valid!' }, { quoted: msg });
                }
            }

            // YOUTUBE MP3
            else if (command === '.ytmp3') {
                if (!textInput) {
                    return sock.sendMessage(from, { text: '⚠️ Masukkan link YouTube!\nContoh: *.ytmp3 https://youtu.be/...*' }, { quoted: msg });
                }
                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });
                try {
                    const res = await fetch(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(textInput)}`).then(r => r.json()).catch(() => null);
                    if (res && res.status && res.data) {
                        const audioUrl = res.data.dl || res.data.url;
                        await sock.sendMessage(from, { audio: { url: audioUrl }, mimetype: 'audio/mp4', ptt: false }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } else {
                        throw new Error('API ytmp3 tidak merespon.');
                    }
                } catch (err) {
                    console.error('Error YTMP3:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengunduh audio YouTube.' }, { quoted: msg });
                }
            }

            // WELCOME SETTINGS
            else if (command === '.on' || command === '.off' || command === '.setwelcome') {
                if (!isGroup) {
                    return sock.sendMessage(from, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                }

                try {
                    const groupMetadata = await getGroupMetadataCached(sock, from);
                    const participants = groupMetadata ? groupMetadata.participants || [] : [];
                    const senderParticipant = participants.find(p => extractNumber(p.id) === senderNumber);
                    const isGroupAdmin = senderParticipant && (senderParticipant.admin === 'admin' || senderParticipant.admin === 'superadmin');

                    if (!isGroupAdmin && !isOwnerOrVip) {
                        return sock.sendMessage(from, { text: '❌ Perintah khusus *Admin Grup* atau *Owner/VIP*!' }, { quoted: msg });
                    }

                    let welcomeSettings = loadWelcomeSettings();
                    if (!welcomeSettings[from]) {
                        welcomeSettings[from] = {
                            enabled: false,
                            text: 'Halo @user, selamat datang di @subject!'
                        };
                    }

                    if (command === '.on') {
                        let subArg = args[0] ? args[0].toLowerCase() : '';
                        if (subArg === 'welcome') {
                            welcomeSettings[from].enabled = true;
                            saveWelcomeSettings(welcomeSettings);
                            await sock.sendMessage(from, { text: '✅ Fitur *Welcome* berhasil dihidupkan!' }, { quoted: msg });
                            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        } else {
                            await sock.sendMessage(from, { text: '⚠️ Penggunaan: *.on welcome*' }, { quoted: msg });
                        }
                    } 
                    else if (command === '.off') {
                        let subArg = args[0] ? args[0].toLowerCase() : '';
                        if (subArg === 'welcome') {
                            welcomeSettings[from].enabled = false;
                            saveWelcomeSettings(welcomeSettings);
                            await sock.sendMessage(from, { text: '✅ Fitur *Welcome* berhasil dimatikan!' }, { quoted: msg });
                            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        } else {
                            await sock.sendMessage(from, { text: '⚠️ Penggunaan: *.off welcome*' }, { quoted: msg });
                        }
                    }
                    else if (command === '.setwelcome') {
                        const newWelcomeText = textInput;
                        if (!newWelcomeText) {
                            return sock.sendMessage(from, { text: `⚠️ Masukkan teks sambutan!\nContoh:\n*.setwelcome Halo @user, selamat datang di @subject!*` }, { quoted: msg });
                        }

                        welcomeSettings[from].text = newWelcomeText;
                        saveWelcomeSettings(welcomeSettings);
                        await sock.sendMessage(from, { text: '✅ Teks *Welcome* berhasil diperbarui!' }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    }

                } catch (err) {
                    console.error('Error Welcome Settings:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengatur fitur welcome.' }, { quoted: msg });
                }
            }

            // STIKER
            else if (command === '.sticker' || command === '.stiker' || command === '.s') {
                try {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const qMsg = contextInfo?.quotedMessage;
                    const isDirectImage = msg.message.imageMessage;
                    const isDirectVideo = msg.message.videoMessage;
                    
                    let quotedMediaMsg = qMsg?.imageMessage || 
                                         qMsg?.videoMessage ||
                                         qMsg?.ephemeralMessage?.message?.imageMessage || 
                                         qMsg?.ephemeralMessage?.message?.videoMessage || 
                                         qMsg?.viewOnceMessage?.message?.imageMessage ||
                                         qMsg?.viewOnceMessage?.message?.videoMessage;

                    if (!isDirectImage && !isDirectVideo && !quotedMediaMsg) {
                        return sock.sendMessage(from, { text: '⚠️ Kirim atau reply foto/video dengan caption *.stiker*!' }, { quoted: msg });
                    }

                    let mediaTarget = msg;
                    let mimeType = isDirectVideo ? 'video/mp4' : (isDirectImage ? 'image/jpeg' : (quotedMediaMsg?.mimetype || 'image/jpeg'));

                    if (quotedMediaMsg) {
                        mediaTarget = {
                            key: { remoteJid: from, fromMe: false, id: contextInfo.stanzaId, participant: contextInfo.participant || from },
                            message: qMsg
                        };
                    }

                    let mediaBuffer = await downloadMediaMessage(mediaTarget, 'buffer', {});
                    if (!mediaBuffer || mediaBuffer.length === 0) throw new Error('Buffer kosong.');

                    let stickerBuffer = await makeSticker(mediaBuffer, mimeType);
                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                } catch (err) {
                    console.error('Error Sticker Detail:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal membuat stiker.' }, { quoted: msg });
                }
            }

            // WATERMARK STIKER
            else if (command === '.wm' || command === '.watermark') {
                try {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const qMsg = contextInfo?.quotedMessage;
                    let quotedStickerMsg = qMsg?.stickerMessage || qMsg?.ephemeralMessage?.message?.stickerMessage;

                    if (!quotedStickerMsg) {
                        return sock.sendMessage(from, { text: '⚠️ Reply stiker yang ingin diambil/dibuat ulang!' }, { quoted: msg });
                    }

                    const mediaTarget = {
                        key: { remoteJid: from, fromMe: false, id: contextInfo.stanzaId, participant: contextInfo.participant || from },
                        message: qMsg
                    };

                    const mediaBuffer = await downloadMediaMessage(mediaTarget, 'buffer', {});
                    if (!mediaBuffer || mediaBuffer.length === 0) throw new Error('Buffer stiker kosong.');

                    await sock.sendMessage(from, { sticker: mediaBuffer }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } catch (err) {
                    console.error('Error Watermark Detail:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal memproses stiker.' }, { quoted: msg });
                }
            }

            // READ VIEW ONCE
            else if (command === '.rvo' || command === '.readviewonce') {
                try {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const qMsg = contextInfo?.quotedMessage;

                    if (!qMsg) {
                        return sock.sendMessage(from, { text: '⚠️ Reply foto atau video sekali lihat (view once)!' }, { quoted: msg });
                    }

                    const viewOnceMsg = qMsg.viewOnceMessage?.message || 
                                        qMsg.viewOnceMessageV2?.message || 
                                        qMsg.ephemeralMessage?.message?.viewOnceMessage?.message;

                    const mediaMessage = viewOnceMsg?.imageMessage || viewOnceMsg?.videoMessage || qMsg.imageMessage || qMsg.videoMessage;

                    if (!mediaMessage) {
                        return sock.sendMessage(from, { text: '❌ Pesan yang kamu reply bukan media *View Once*!' }, { quoted: msg });
                    }

                    const mediaTarget = {
                        key: { remoteJid: from, fromMe: false, id: contextInfo.stanzaId, participant: contextInfo.participant || from },
                        message: qMsg
                    };

                    const mediaBuffer = await downloadMediaMessage(mediaTarget, 'buffer', {});
                    if (!mediaBuffer || mediaBuffer.length === 0) throw new Error('Buffer media kosong.');

                    const caption = mediaMessage.caption || 'Nih pesan view once-nya berhasil dibongkar 🔓';

                    if (mediaMessage.mimetype && mediaMessage.mimetype.includes('video')) {
                        await sock.sendMessage(from, { video: mediaBuffer, caption: caption }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { image: mediaBuffer, caption: caption }, { quoted: msg });
                    }
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                } catch (err) {
                    console.error('Error RVO Detail:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal membuka pesan View Once.' }, { quoted: msg });
                }
            }

            // HIDETAG
            else if (command === '.ah' || command === '.hidetag') {
                if (!isGroup) {
                    return sock.sendMessage(from, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                }

                try {
                    const groupMetadata = await getGroupMetadataCached(sock, from);
                    const participants = groupMetadata ? groupMetadata.participants || [] : [];
                    const adminParticipants = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
                    const adminNumbers = adminParticipants.map(p => extractNumber(p.id));

                    const isSenderAdmin = adminNumbers.includes(senderNumber);

                    if (!isSenderAdmin && !isOwnerOrVip) {
                        return sock.sendMessage(from, { text: '❌ Perintah khusus *Admin Grup* atau *Owner/VIP*!' }, { quoted: msg });
                    }

                    const qMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const quotedText = qMsg?.conversation || qMsg?.extendedTextMessage?.text || qMsg?.imageMessage?.caption || qMsg?.videoMessage?.caption || '';

                    const finalHidetagText = textInput || quotedText;

                    if (!finalHidetagText) {
                        return sock.sendMessage(from, { text: '⚠️ Masukkan teks atau reply pesan!\nContoh: *.ah Pengumuman*' }, { quoted: msg });
                    }

                    const allMembers = participants.map(p => p.id);
                    await sock.sendMessage(from, { text: finalHidetagText, mentions: allMembers }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                } catch (err) {
                    console.error('Error Hidetag Detail:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengeksekusi fitur hidetag.' }, { quoted: msg });
                }
            }

            // GAME RPG
            else if (['.rpg', '.status', '.profile', '.pilihjob', '.adventure', '.hunt', '.heal', '.leaderboard', '.toprpg'].includes(command)) {
                let rpgDb = loadRpgDb();
                if (!rpgDb[senderNumber]) {
                    rpgDb[senderNumber] = {
                        name: msg.pushName || "Adventurer",
                        job: null,
                        level: 1,
                        exp: 0,
                        maxExp: 100,
                        hp: 100,
                        maxHp: 100,
                        atk: 10,
                        gold: 50,
                        weapon: "Tangan Kosong"
                    };
                }
                let player = rpgDb[senderNumber];

                if (command === '.rpg' || command === '.status' || command === '.profile') {
                    let txt = `⚔️ *RPG PROFILE* ⚔️\n\n` +
                              `👤 *Nama:* ${player.name}\n` +
                              `🛡️ *Job:* ${player.job ? player.job.toUpperCase() : 'Belum Memilih (.pilihjob)'}\n` +
                              `⭐ *Level:* ${player.level}\n` +
                              `✨ *EXP:* ${player.exp} / ${player.maxExp}\n` +
                              `❤️ *HP:* ${player.hp} / ${player.maxHp}\n` +
                              `🗡️ *Attack:* ${player.atk}\n` +
                              `💰 *Gold:* ${player.gold}\n` +
                              `🗡️ *Senjata:* ${player.weapon}\n\n` +
                              `_Ketik .adventure untuk mulai berburu!_`;
                    await sock.sendMessage(from, { text: txt }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } 
                else if (command === '.pilihjob') {
                    let choice = args[0] ? args[0].toLowerCase() : '';
                    if (player.job) {
                        return sock.sendMessage(from, { text: `⚠️ Kamu sudah memilih job *${player.job.toUpperCase()}*!` }, { quoted: msg });
                    }

                    if (choice === 'warrior') {
                        player.job = 'warrior';
                        player.maxHp = 150; player.hp = 150; player.atk = 15; player.weapon = 'Pedang Kayu';
                    } else if (choice === 'mage') {
                        player.job = 'mage';
                        player.maxHp = 80; player.hp = 80; player.atk = 25; player.weapon = 'Tongkat Sihir Pemula';
                    } else if (choice === 'archer') {
                        player.job = 'archer';
                        player.maxHp = 100; player.hp = 100; player.atk = 20; player.weapon = 'Busur Kayu';
                    } else {
                        return sock.sendMessage(from, { text: `⚔️ *PILIH JOB RPG* ⚔️\n\nKetik:\n- *.pilihjob warrior*\n- *.pilihjob mage*\n- *.pilihjob archer*` }, { quoted: msg });
                    }

                    saveRpgDb(rpgDb);
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                }
                else if (command === '.adventure' || command === '.hunt') {
                    if (!player.job) {
                        return sock.sendMessage(from, { text: `⚠️ Pilih job kamu dulu dengan *.pilihjob [warrior/mage/archer]*` }, { quoted: msg });
                    }
                    if (player.hp <= 30) {
                        return sock.sendMessage(from, { text: `❤️ HP kamu terlalu rendah (${player.hp}), silakan berobat dulu dengan *.heal*!` }, { quoted: msg });
                    }

                    const monsters = [
                        { name: 'Slime Hijau', hp: 30, atk: 5, expGained: 25, goldGained: 10 },
                        { name: 'Goblin Liar', hp: 50, atk: 12, expGained: 45, goldGained: 25 },
                        { name: 'Orc Beruntung', hp: 90, atk: 20, expGained: 80, goldGained: 50 },
                        { name: 'Baby Dragon', hp: 150, atk: 35, expGained: 150, goldGained: 120 }
                    ];

                    let monster = monsters[Math.floor(Math.random() * monsters.length)];
                    let damageDealt = player.atk + Math.floor(Math.random() * 10);
                    let damageTaken = Math.max(5, monster.atk - Math.floor(Math.random() * 5));
                    
                    player.hp -= damageTaken;
                    if (player.hp < 0) player.hp = 0;

                    player.exp += monster.expGained;
                    player.gold += monster.goldGained;

                    let textResult = `🌲 Bertemu *${monster.name}*!\n- Menyerang: ${damageDealt} DMG\n- Terkena damage: -${damageTaken} HP\n\n` +
                                     `🏆 *MENANG!*\n✨ EXP +${monster.expGained}\n💰 Gold +${monster.goldGained}\n❤️ Sisa HP: ${player.hp}/${player.maxHp}\n`;

                    if (player.exp >= player.maxExp) {
                        player.level += 1;
                        player.exp -= player.maxExp;
                        player.maxExp += 50;
                        player.maxHp += 20;
                        player.hp = player.maxHp;
                        player.atk += 5;
                        textResult += `\n🎉 *LEVEL UP!* Kamu naik ke Level *${player.level}*!`;
                    }

                    saveRpgDb(rpgDb);
                    await sock.sendMessage(from, { text: textResult }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                }
                else if (command === '.heal') {
                    let cost = 20;
                    if (player.hp === player.maxHp) {
                        return sock.sendMessage(from, { text: `❤️ HP kamu sudah penuh!` }, { quoted: msg });
                    }
                    if (player.gold < cost) {
                        return sock.sendMessage(from, { text: `💰 Gold kurang! Biaya heal ${cost} Gold.` }, { quoted: msg });
                    }

                    player.gold -= cost;
                    player.hp = player.maxHp;
                    saveRpgDb(rpgDb);
                    await sock.sendMessage(from, { text: `❤️ Berhasil memulihkan HP hingga penuh!` }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                }
                else if (command === '.leaderboard' || command === '.toprpg') {
                    let sorted = Object.values(rpgDb).sort((a, b) => b.level - a.level || b.gold - a.gold).slice(0, 5);
                    let text = `🏆 *TOP 5 LEADERBOARD RPG* 🏆\n\n`;
                    sorted.forEach((p, i) => {
                        text += `${i + 1}. *${p.name}* | Lv: ${p.level} | Gold: ${p.gold} (${p.job ? p.job.toUpperCase() : 'No Job'})\n`;
                    });
                    await sock.sendMessage(from, { text: text }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                }
            }

            // PENGELOLAAN MANAJEMEN GRUP
            else if (['.masukin', '.ewein', '.promote', '.demote'].includes(command)) {
                if (!isGroup) {
                    return sock.sendMessage(from, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                }

                try {
                    const groupMetadata = await getGroupMetadataCached(sock, from);
                    const participants = groupMetadata ? groupMetadata.participants || [] : [];
                    
                    const currentSenderJid = msg.key.participant || msg.key.remoteJid;
                    const cleanSenderNumber = extractNumber(currentSenderJid);

                    const senderParticipant = participants.find(p => extractNumber(p.id) === cleanSenderNumber);
                    const isGroupAdmin = senderParticipant && (senderParticipant.admin === 'admin' || senderParticipant.admin === 'superadmin');

                    if (!isGroupAdmin && !isOwnerOrVip) {
                        return sock.sendMessage(from, { text: '❌ Perintah khusus *Admin Grup* atau *Owner/VIP*!' }, { quoted: msg });
                    }

                    if (command === '.masukin') {
                        let targetNumber = textInput ? textInput.replace(/[^0-9]/g, '') : '';
                        if (!targetNumber) {
                            return sock.sendMessage(from, { text: '⚠️ Masukkan nomor!\nContoh: *.masukin 628xxxxxxxxxx*' }, { quoted: msg });
                        }

                        const targetJid = targetNumber + '@s.whatsapp.net';
                        const response = await sock.groupParticipantsUpdate(from, [targetJid], 'add');
                        
                        if (response && response[0]?.status === '403') {
                            await sock.sendMessage(from, { text: '❌ Gagal menambahkan! Target membatasi privasi undangan grup.' }, { quoted: msg });
                        } else {
                            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        }
                    }

                    else if (command === '.ewein' || command === '.promote' || command === '.demote') {
                        const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                        let targetJid = contextInfo?.mentionedJid?.[0];

                        if (!targetJid && args[0]) {
                            const cleanNum = args[0].replace(/[^0-9]/g, '');
                            if (cleanNum) targetJid = cleanNum + '@s.whatsapp.net';
                        }

                        if (!targetJid && contextInfo?.participant && !contextInfo.participant.endsWith('@g.us')) {
                            targetJid = contextInfo.participant;
                        }

                        if (!targetJid) {
                            return sock.sendMessage(from, { text: `⚠️ Tag atau reply member yang ingin di-${command.replace('.', '')}!` }, { quoted: msg });
                        }

                        const actionMap = {
                            '.ewein': 'remove',
                            '.promote': 'promote',
                            '.demote': 'demote'
                        };

                        await sock.groupParticipantsUpdate(from, [targetJid], actionMap[command]);
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    }

                } catch (err) {
                    console.error('Error Group Management:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengeksekusi perintah. Pastikan bot berstatus *Admin*!' }, { quoted: msg });
                }
            }

        } catch (err) {
            console.error('Error Message Upsert:', err);
        }
    });
} 

connectToWhatsApp();
