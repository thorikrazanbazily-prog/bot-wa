const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { TTScraper } = require('tiktok-scraper-ts');

// Inisialisasi TikTok Scraper (Tanpa API Key)
const TikTokScraper = new TTScraper();

// ==========================================
// KONFIGURASI OWNER & VIP
// ==========================================
const ownerNumbers = ['255164158062616']; // Ubah/Tambahkan nomor Owner Anda di sini
const vipNumbers = []; // Tambahkan nomor VIP jika ada

// ==========================================
// FILE LOKAL DATABASE & PATH FOTO
// ==========================================
const CONTROL_FILE = 'bot_control.json';
const WELCOME_SETTINGS_FILE = 'welcome_settings.json';
const VERIFIED_USERS_FILE = 'verified_users.json'; 
const CUSTOM_THUMB_PATH = path.join(__dirname, 'thumb.jpg'); 

// Helper load & save database lokal
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

const loadVerifiedUsers = () => {
    try {
        if (fs.existsSync(VERIFIED_USERS_FILE)) {
            return JSON.parse(fs.readFileSync(VERIFIED_USERS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Gagal membaca database verified_users:', e);
    }
    return {};
};

const saveVerifiedUsers = (users) => {
    try {
        fs.writeFileSync(VERIFIED_USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('Gagal menyimpan database verified_users:', e);
    }
};

// ==========================================
// FUNGSI FETCH PROFIL TIKTOK (TIKTOK SCRAPER TS)
// ==========================================
async function fetchTikTokProfile(username) {
    const cleanUsername = username.replace('@', '').trim();

    // -------------------------------------------------------------
    // UTAMA: TIKTOK-SCRAPER-TS (GRATIS / SCRAPER)
    // -------------------------------------------------------------
    try {
        const userProfile = await TikTokScraper.user(cleanUsername);

        if (userProfile && (userProfile.uniqueId || userProfile.nickname)) {
            return {
                success: true,
                data: {
                    user: {
                        uniqueId: userProfile.uniqueId || cleanUsername,
                        nickname: userProfile.nickname || cleanUsername,
                        avatarMedium: userProfile.avatar || userProfile.avatarMedium || '',
                        signature: userProfile.signature || userProfile.bio || 'Tidak ada bio',
                        verified: userProfile.verified || false
                    },
                    stats: {
                        followerCount: userProfile.fans || userProfile.followers || userProfile.followerCount || 0,
                        followingCount: userProfile.following || userProfile.followingCount || 0,
                        heartCount: userProfile.heart || userProfile.likes || userProfile.heartCount || 0,
                        videoCount: userProfile.video || userProfile.videoCount || 0
                    }
                }
            };
        }
    } catch (err) {
        console.error('TikTok Scraper Error:', err.message || err);
    }

    // -------------------------------------------------------------
    // FALLBACK: TIKWM PUBLIC API (Jika Scraper Terhalang CAPTCHA)
    // -------------------------------------------------------------
    try {
        const fallbackRes = await axios({
            method: 'POST',
            url: 'https://www.tikwm.com/api/user/info',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            data: new URLSearchParams({ unique_id: cleanUsername }).toString(),
            timeout: 7000
        });

        if (fallbackRes.data && fallbackRes.data.code === 0 && fallbackRes.data.data) {
            const data = fallbackRes.data.data;
            return {
                success: true,
                data: {
                    user: {
                        uniqueId: data.user.uniqueId || cleanUsername,
                        nickname: data.user.nickname || cleanUsername,
                        avatarMedium: data.user.avatarMedium || data.user.avatarThumb || '',
                        signature: data.user.signature || 'Tidak ada bio',
                        verified: data.user.verified || false
                    },
                    stats: {
                        followerCount: data.stats.followerCount || 0,
                        followingCount: data.stats.followingCount || 0,
                        heartCount: data.stats.heartCount || 0,
                        videoCount: data.stats.videoCount || 0
                    }
                }
            };
        }
    } catch (e) {
        console.log('Fallback TikWM gagal.');
    }

    return { 
        success: false, 
        message: 'Gagal mengambil data dari TikTok. Username tidak ditemukan atau server terhalang CAPTCHA.' 
    };
}

// ==========================================
// CACHE & HELPER CONFIG
// ==========================================
const groupMembersCache = {};

const extractNumber = (jid) => {
    if (!jid || typeof jid !== 'string') return '';
    const clean = jid.split('@')[0].split(':')[0];
    return clean.replace(/[^0-9]/g, '');
};

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

function getImagePayload() {
    if (fs.existsSync(CUSTOM_THUMB_PATH)) {
        return { url: CUSTOM_THUMB_PATH };
    }
    return { url: 'https://picsum.photos/800/800' };
}

async function sendPhotoResponse(sock, from, textMsg, quotedMsg, imageUrl = null) {
    try {
        const imageSrc = imageUrl ? { url: imageUrl } : getImagePayload();
        await sock.sendMessage(from, {
            image: imageSrc,
            caption: textMsg
        }, { quoted: quotedMsg });
    } catch (err) {
        console.error('Gagal mengirim foto respon, mengirim teks biasa:', err.message);
        await sock.sendMessage(from, { text: textMsg }, { quoted: quotedMsg });
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

    // LISTENER WELCOME MEMBER BARU
    sock.ev.on('group-participants.update', async (anu) => {
        try {
            const { id: groupId, participants, action } = anu;
            if (action !== 'add') return;

            let welcomeSettings = loadWelcomeSettings();
            if (!welcomeSettings[groupId] || !welcomeSettings[groupId].enabled) return;

            let customText = welcomeSettings[groupId].text || 'Halo @user, selamat datang di @subject! Semoga betah ya!';
            const groupMetadata = await getGroupMetadataCached(sock, groupId);
            const groupName = groupMetadata ? groupMetadata.subject : 'Grup ini';

            for (let num of participants) {
                const jid = typeof num === 'string' ? num : (num.id || num.jid || '');
                if (!jid) continue;

                const numericId = extractNumber(jid);
                const userTag = `@${numericId}`;
                
                let finalWelcome = customText
                    .replace(/@user/g, userTag)
                    .replace(/@subject/g, groupName);

                await sock.relayMessage(
                    groupId,
                    {
                        interactiveMessage: {
                            body: { text: finalWelcome },
                            footer: { text: `Welcome System | ${groupName}` },
                            header: { hasMediaAttachment: false },
                            nativeFlowMessage: {
                                buttons: [
                                    { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "📜 Lihat Menu", id: ".menu" }) },
                                    { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "⚡ Cek Ping", id: ".ping" }) },
                                    { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "👑 Owner", id: ".owner" }) }
                                ],
                                messageParamsJson: "{}"
                            },
                            contextInfo: { mentionedJid: [jid] }
                        }
                    },
                    {
                        additionalNodes: [
                            {
                                tag: "biz",
                                attrs: {},
                                content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }]
                            }
                        ]
                    }
                ).catch(async () => {
                    await sock.sendMessage(groupId, {
                        image: getImagePayload(),
                        caption: finalWelcome,
                        mentions: [jid]
                    });
                });
            }
        } catch (err) {
            console.error('Error Group Participants Update:', err);
        }
    });

    // LISTENER PESAN MASUK
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

            const isOwner = ownerNumbers.includes(senderNumber);
            const isVip = vipNumbers.includes(senderNumber);
            const isOwnerOrVip = isOwner || isVip;

            const botControl = loadBotControl();
            if (botControl.isPrivate && !isOwnerOrVip) {
                if (isGroup) {
                    if (!botControl.allowedGroups.includes(from)) return;
                } else {
                    return;
                }
            }

            let messageContent = msg.message;
            while (
                messageContent?.ephemeralMessage || 
                messageContent?.viewOnceMessage || 
                messageContent?.viewOnceMessageV2 || 
                messageContent?.viewOnceMessageV2Extension
            ) {
                messageContent = 
                    messageContent.ephemeralMessage?.message || 
                    messageContent.viewOnceMessage?.message || 
                    messageContent.viewOnceMessageV2?.message || 
                    messageContent.viewOnceMessageV2Extension?.message;
            }

            if (!messageContent) return;

            let body = '';

            if (messageContent.conversation) {
                body = messageContent.conversation;
            } else if (messageContent.extendedTextMessage?.text) {
                body = messageContent.extendedTextMessage.text;
            } else if (messageContent.imageMessage?.caption) {
                body = messageContent.imageMessage.caption;
            } else if (messageContent.videoMessage?.caption) {
                body = messageContent.videoMessage.caption;
            } else if (messageContent.interactiveResponseMessage) {
                const nativeParams = messageContent.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson;
                if (nativeParams) {
                    try {
                        const parsed = JSON.parse(nativeParams);
                        body = parsed.id || parsed.text || '';
                    } catch (e) {
                        body = messageContent.interactiveResponseMessage.body?.text || '';
                    }
                } else {
                    body = messageContent.interactiveResponseMessage.body?.text || '';
                }
            } else if (messageContent.templateButtonReplyMessage) {
                const selectedId = messageContent.templateButtonReplyMessage.selectedId;
                const nativeParams = messageContent.templateButtonReplyMessage.quickReplyButtonMessage?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
                
                if (selectedId) {
                    body = selectedId;
                } else if (nativeParams) {
                    try {
                        const parsed = JSON.parse(nativeParams);
                        body = parsed.id || '';
                    } catch (e) {
                        body = messageContent.templateButtonReplyMessage.selectedDisplayText || '';
                    }
                } else {
                    body = messageContent.templateButtonReplyMessage.selectedDisplayText || '';
                }
            } else if (messageContent.buttonsResponseMessage) {
                body = messageContent.buttonsResponseMessage.selectedButtonId || messageContent.buttonsResponseMessage.selectedButtonText || '';
            } else if (messageContent.listResponseMessage) {
                body = messageContent.listResponseMessage.singleSelectReply?.selectedRowId || '';
            }

            const text = (body || '').trim();
            let command = '';
            let textInput = '';

            if (text.startsWith('.')) {
                const args = text.split(/ +/);
                command = args.shift().toLowerCase();
                textInput = args.join(' ');
            } else if (text.toLowerCase() === 'lihat menu' || text.toLowerCase() === '📜 lihat menu') {
                command = '.menu';
            } else if (text.toLowerCase() === 'cek ping' || text.toLowerCase() === '⚡ cek ping') {
                command = '.ping';
            } else if (text.toLowerCase() === 'owner' || text.toLowerCase() === '👑 owner') {
                command = '.owner';
            } else {
                const args = text.split(/ +/);
                command = args.length > 0 ? args.shift().toLowerCase() : '';
                textInput = args.join(' ');
            }

            // SETTING FOTO THUMBNAIL LOKAL
            if (command === '.setthumb' || command === '.setfoto') {
                if (!isOwnerOrVip) {
                    return sendPhotoResponse(sock, from, '❌ Perintah ini khusus untuk *Owner* dan *VIP*!', msg);
                }

                const isImage = !!messageContent.imageMessage;
                const isQuotedImage = !!messageContent.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

                if (!isImage && !isQuotedImage) {
                    return sendPhotoResponse(sock, from, '⚠️ Kirim foto dengan caption *.setthumb* atau *reply foto* yang ingin dijadikan tampilan bot!', msg);
                }

                try {
                    await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });

                    let targetMsg = msg;
                    if (isQuotedImage) {
                        targetMsg = { message: messageContent.extendedTextMessage.contextInfo.quotedMessage };
                    }

                    const buffer = await downloadMediaMessage(
                        targetMsg,
                        'buffer',
                        {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );

                    fs.writeFileSync(CUSTOM_THUMB_PATH, buffer);

                    await sendPhotoResponse(sock, from, '✅ Foto respon bot berhasil diperbarui dari gambar lokal!', msg);
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } catch (err) {
                    console.error('Error menyimpan foto thumb:', err);
                    await sendPhotoResponse(sock, from, '❌ Gagal mengunduh dan menyimpan foto.', msg);
                }
            }
            else if (command === '.resetthumb' || command === '.resetfoto') {
                if (!isOwnerOrVip) {
                    return sendPhotoResponse(sock, from, '❌ Perintah ini khusus untuk *Owner* dan *VIP*!', msg);
                }

                if (fs.existsSync(CUSTOM_THUMB_PATH)) {
                    fs.unlinkSync(CUSTOM_THUMB_PATH);
                }

                await sendPhotoResponse(sock, from, '✅ Foto respon bot berhasil dihapus dan dikembalikan ke bawaan!', msg);
                await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
            }

            // KONTROL BOT (OWNER & VIP)
            else if (['.private', '.public', '.addgc', '.delgc'].includes(command)) {
                if (!isOwnerOrVip) {
                    return sendPhotoResponse(sock, from, '❌ Perintah ini khusus untuk *Owner* dan *VIP*!', msg);
                }

                let control = loadBotControl();

                if (command === '.private') {
                    control.isPrivate = true;
                    saveBotControl(control);
                    await sendPhotoResponse(sock, from, '🔒 Bot berhasil diubah ke mode *PRIVATE* (Hanya Owner/VIP & Grup whitelist).', msg);
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } 
                else if (command === '.public') {
                    control.isPrivate = false;
                    saveBotControl(control);
                    await sendPhotoResponse(sock, from, '🔓 Bot berhasil diubah ke mode *PUBLIC* (Dapat digunakan oleh siapa saja).', msg);
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } 
                else if (command === '.addgc') {
                    if (!isGroup) {
                        return sendPhotoResponse(sock, from, '❌ Perintah ini hanya bisa digunakan di dalam grup!', msg);
                    }
                    if (control.allowedGroups.includes(from)) {
                        return sendPhotoResponse(sock, from, '⚠️ Grup ini sudah terdaftar dalam akses bot.', msg);
                    }
                    control.allowedGroups.push(from);
                    saveBotControl(control);
                    await sendPhotoResponse(sock, from, '✅ Grup ini berhasil diberikan akses (whitelist) untuk menggunakan bot!', msg);
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } 
                else if (command === '.delgc') {
                    if (!isGroup) {
                        return sendPhotoResponse(sock, from, '❌ Perintah ini hanya bisa digunakan di dalam grup!', msg);
                    }
                    const index = control.allowedGroups.indexOf(from);
                    if (index === -1) {
                        return sendPhotoResponse(sock, from, '⚠️ Grup ini tidak ada dalam daftar izin bot.', msg);
                    }
                    control.allowedGroups.splice(index, 1);
                    saveBotControl(control);
                    await sendPhotoResponse(sock, from, '❌ Akses grup ini telah dicabut dari bot.', msg);
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                }
            }

            // MENU, PING & OWNER
            else if (command === '.menu' || command === '.help') {
                const menuText = 
`😳 *BOT RIQ IMUP* 😳

👑 *OWNER & VIP TOOLS*
* ➔ *.setthumb* : Kirim/reply foto untuk dijadikan foto respon
* ➔ *.resetthumb* : Hapus foto custom & kembalikan ke bawaan
* ➔ *.private* : Batasi bot hanya untuk Owner/VIP & GC whitelist
* ➔ *.public* : Buka bot untuk umum
* ➔ *.addgc* : Beri akses bot ke grup ini
* ➔ *.delgc* : Cabut akses bot dari grup ini

📌 *PERINTAH UTAMA*
* ➔ *.menu* : Menampilkan menu
* ➔ *.ping* : Cek kecepatan respon bot
* ➔ *.owner* : Kontak Owner Bot

🎵 *VERIFIKASI TIKTOK*
* ➔ *.verif <username>* : Verifikasi & tampilkan data akun TikTok

⭐️ *FITUR CN DAN BIO*
* ➔ *.cn* : CN Kageye
* ➔ *.bio* : BIO Kageye

👋 *FITUR WELCOME (SELAMAT DATANG)*
* ➔ *.on welcome* : Menghidupkan fitur sambutan member baru + CTA Button
* ➔ *.off welcome* : Mematikan fitur sambutan member baru
* ➔ *.setwelcome <teks>* : Mengatur teks sambutan (Gunakan *@user* dan *@subject*)

👥 *GRUP & MANAJEMEN*
* ➔ *.ah <pesan> / reply* : Hidetag (Mention seluruh member)
* ➔ *.masukin <nomor>* : Menambahkan member ke grup
* ➔ *.ewein @user* : Mencopot/mengeluarkan member dari grup
* ➔ *.promote / .demote @user* : Atur admin grup`;

                await sendPhotoResponse(sock, from, menuText, msg);
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

                await sendPhotoResponse(sock, from, pingText, msg);
                await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
            }
            else if (command === '.owner') {
                await sendPhotoResponse(sock, from, `👑 *Owner Bot:* wa.me/${ownerNumbers[0]}`, msg);
                await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
            }

            // VERIFIKASI AKUN TIKTOK (MENGGUNAKAN TIKTOK SCRAPER TS)
            else if (command === '.verif' || command === '.verifikasi') {
                if (!textInput) {
                    return sendPhotoResponse(sock, from, '⚠️ Masukkan username TikTok kamu!\n\nContoh:\n*.verif username_tiktok*', msg);
                }

                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });

                const ttResult = await fetchTikTokProfile(textInput);

                if (!ttResult.success) {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    return sendPhotoResponse(sock, from, `❌ *Verifikasi Gagal:*\n${ttResult.message}`, msg);
                }

                const user = ttResult.data.user;
                const stats = ttResult.data.stats;

                let verifiedUsers = loadVerifiedUsers();
                verifiedUsers[senderNumber] = {
                    waNumber: senderNumber,
                    tiktokUsername: user.uniqueId,
                    nickname: user.nickname,
                    avatar: user.avatarMedium,
                    verifiedAt: new Date().toISOString()
                };
                saveVerifiedUsers(verifiedUsers);

                const avatarUrl = user.avatarMedium;
                const isVerifiedBadge = user.verified ? '✅ Verified Official' : '❌ Unverified Badge';

                const verifMsg = 
`🎵 *VERIFIKASI AKUN TIKTOK BERHASIL* 🎵

👤 *INFORMASI PROFIL*
• *Nama:* ${user.nickname || '-'}
• *Username:* @${user.uniqueId}
• *Status Lencana:* ${isVerifiedBadge}
• *Bio:* ${user.signature || 'Tidak ada bio'}

📊 *STATISTIK AKUN*
• 👥 *Pengikut (Followers):* ${stats.followerCount?.toLocaleString('id-ID') || 0}
• 👤 *Mengikuti (Following):* ${stats.followingCount?.toLocaleString('id-ID') || 0}
• ❤️ *Total Suka (Likes):* ${stats.heartCount?.toLocaleString('id-ID') || 0}
• 📹 *Total Video:* ${stats.videoCount?.toLocaleString('id-ID') || 0}

🔗 *Link Profil:* https://www.tiktok.com/@${user.uniqueId}

_Nomor WhatsApp Anda (${senderNumber}) berhasil diverifikasi dengan akun TikTok diatas!_`;

                await sendPhotoResponse(sock, from, verifMsg, msg, avatarUrl);
                await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
            }

            // BUTTON CN
            else if (command === '.cn') {
                let query = textInput || '';
                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });

                try {
                    await sock.relayMessage(
                        from,
                        {
                            "interactiveMessage": {
                                "body": { "text": `*CN Kageye* ${query}` },
                                "footer": { "text": "pilih salah satu" },
                                "nativeFlowMessage": {
                                    "buttons": [
                                        { "name": "cta_copy", "buttonParamsJson": JSON.stringify({ "display_text": "𝐊—", "copy_code": `𝐊—${query}` }) },
                                        { "name": "cta_copy", "buttonParamsJson": JSON.stringify({ "display_text": "𝖋𝖙 𝙆𝙂𝙔", "copy_code": `𝖋𝖙 𝙆𝙂𝙔 ${query}` }) },
                                        { "name": "cta_copy", "buttonParamsJson": JSON.stringify({ "display_text": "𝐊𝐚𝐠𝐮𝐲𝐚\`", "copy_code": `𝐊𝐚𝐠𝐮𝐲𝐚\`${query}` }) },
                                        { "name": "cta_copy", "buttonParamsJson": JSON.stringify({ "display_text": "水", "copy_code": `水 ${query}` }) }
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
                                    "content": [{ "tag": "interactive", "attrs": { "type": "native_flow", "v": "1" }, "content": [{ "tag": "native_flow", "attrs": { "v": "9", "name": "mixed" } }] }]
                                }
                            ]
                        }
                    );
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } catch (err) {
                    console.error('Error Relay Message CTA Copy:', err);
                    await sendPhotoResponse(sock, from, `❌ Gagal mengirim pesan interaktif.`, msg);
                }
            }

            // BUTTON BIO 
            else if (command === '.bio') {
                let query = textInput || '';
                await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });

                try {
                    await sock.relayMessage(
                        from,
                        {
                            "interactiveMessage": {
                                "body": { "text": `*BIO Kageye* ${query}` },
                                "footer": { "text": "pasang di bio akun tiktok" },
                                "nativeFlowMessage": {
                                    "buttons": [
                                        { "name": "cta_copy", "buttonParamsJson": JSON.stringify({ "display_text": "𝐏𝐀𝐑𝐓 𝐎𝐅 𝐊𝐀𝐆𝐔𝐘𝐀", "copy_code": `𝐏𝐀𝐑𝐓 𝐎𝐅 𝐊𝐀𝐆𝐔𝐘𝐀 ${query}` }) }
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
                                    "content": [{ "tag": "interactive", "attrs": { "type": "native_flow", "v": "1" }, "content": [{ "tag": "native_flow", "attrs": { "v": "9", "name": "mixed" } }] }]
                                }
                            ]
                        }
                    );
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } catch (err) {
                    console.error('Error Relay Message CTA Copy Bio:', err);
                    await sendPhotoResponse(sock, from, `❌ Gagal mengirim pesan interaktif.`, msg);
                }
            }

            // WELCOME SETTINGS
            else if (command === '.on' || command === '.off' || command === '.setwelcome') {
                if (!isGroup) {
                    return sendPhotoResponse(sock, from, '❌ Perintah ini hanya bisa digunakan di dalam grup!', msg);
                }

                try {
                    const groupMetadata = await getGroupMetadataCached(sock, from);
                    const participants = groupMetadata ? groupMetadata.participants || [] : [];
                    const senderParticipant = participants.find(p => extractNumber(p.id) === senderNumber);
                    const isGroupAdmin = senderParticipant && (senderParticipant.admin === 'admin' || senderParticipant.admin === 'superadmin');

                    if (!isGroupAdmin && !isOwnerOrVip) {
                        return sendPhotoResponse(sock, from, '❌ Perintah khusus *Admin Grup* atau *Owner/VIP*!', msg);
                    }

                    let welcomeSettings = loadWelcomeSettings();
                    if (!welcomeSettings[from]) {
                        welcomeSettings[from] = {
                            enabled: false,
                            text: 'Halo @user, selamat datang di @subject!'
                        };
                    }

                    if (command === '.on') {
                        let subArg = textInput.toLowerCase();
                        if (subArg === 'welcome') {
                            welcomeSettings[from].enabled = true;
                            saveWelcomeSettings(welcomeSettings);
                            await sendPhotoResponse(sock, from, '✅ Fitur *Welcome CTA Button* berhasil dihidupkan!', msg);
                            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        } else {
                            await sendPhotoResponse(sock, from, '⚠️ Penggunaan: *.on welcome*', msg);
                        }
                    } 
                    else if (command === '.off') {
                        let subArg = textInput.toLowerCase();
                        if (subArg === 'welcome') {
                            welcomeSettings[from].enabled = false;
                            saveWelcomeSettings(welcomeSettings);
                            await sendPhotoResponse(sock, from, '✅ Fitur *Welcome* berhasil dimatikan!', msg);
                            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        } else {
                            await sendPhotoResponse(sock, from, '⚠️ Penggunaan: *.off welcome*', msg);
                        }
                    }
                    else if (command === '.setwelcome') {
                        const newWelcomeText = textInput;
                        if (!newWelcomeText) {
                            return sendPhotoResponse(sock, from, `⚠️ Masukkan teks sambutan!\nContoh:\n*.setwelcome Halo @user, selamat datang di @subject!*`, msg);
                        }

                        welcomeSettings[from].text = newWelcomeText;
                        saveWelcomeSettings(welcomeSettings);
                        await sendPhotoResponse(sock, from, '✅ Teks *Welcome* berhasil diperbarui!', msg);
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    }

                } catch (err) {
                    console.error('Error Welcome Settings:', err);
                    await sendPhotoResponse(sock, from, '❌ Gagal mengatur fitur welcome.', msg);
                }
            }

            // HIDETAG
            else if (command === '.ah' || command === '.hidetag') {
                if (!isGroup) {
                    return sendPhotoResponse(sock, from, '❌ Perintah ini hanya bisa digunakan di dalam grup!', msg);
                }

                try {
                    const groupMetadata = await getGroupMetadataCached(sock, from);
                    const participants = groupMetadata ? groupMetadata.participants || [] : [];
                    const adminParticipants = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
                    const adminNumbers = adminParticipants.map(p => extractNumber(p.id));

                    const isSenderAdmin = adminNumbers.includes(senderNumber);

                    if (!isSenderAdmin && !isOwnerOrVip) {
                        return sendPhotoResponse(sock, from, '❌ Perintah khusus *Admin Grup* atau *Owner/VIP*!', msg);
                    }

                    const qMsg = messageContent.extendedTextMessage?.contextInfo?.quotedMessage;
                    const quotedText = qMsg?.conversation || qMsg?.extendedTextMessage?.text || qMsg?.imageMessage?.caption || qMsg?.videoMessage?.caption || '';

                    const finalHidetagText = textInput || quotedText;

                    if (!finalHidetagText) {
                        return sendPhotoResponse(sock, from, '⚠️ Masukkan teks atau reply pesan!\nContoh: *.ah Pengumuman*', msg);
                    }

                    const allMembers = participants.map(p => p.id);

                    await sock.sendMessage(from, {
                        image: getImagePayload(),
                        caption: finalHidetagText,
                        mentions: allMembers
                    }, { quoted: msg }).catch(async () => {
                        await sock.sendMessage(from, { text: finalHidetagText, mentions: allMembers }, { quoted: msg });
                    });

                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                } catch (err) {
                    console.error('Error Hidetag Detail:', err);
                    await sendPhotoResponse(sock, from, '❌ Gagal mengeksekusi fitur hidetag.', msg);
                }
            }

            // PENGELOLAAN MANAJEMEN GRUP
            else if (['.masukin', '.ewein', '.promote', '.demote'].includes(command)) {
                if (!isGroup) {
                    return sendPhotoResponse(sock, from, '❌ Perintah ini hanya bisa digunakan di dalam grup!', msg);
                }

                try {
                    const groupMetadata = await getGroupMetadataCached(sock, from);
                    const participants = groupMetadata ? groupMetadata.participants || [] : [];
                    
                    const currentSenderJid = msg.key.participant || msg.key.remoteJid;
                    const cleanSenderNumber = extractNumber(currentSenderJid);

                    const senderParticipant = participants.find(p => extractNumber(p.id) === cleanSenderNumber);
                    const isGroupAdmin = senderParticipant && (senderParticipant.admin === 'admin' || senderParticipant.admin === 'superadmin');

                    if (!isGroupAdmin && !isOwnerOrVip) {
                        return sendPhotoResponse(sock, from, '❌ Perintah khusus *Admin Grup* atau *Owner/VIP*!', msg);
                    }

                    if (command === '.masukin') {
                        let targetNumber = textInput ? textInput.replace(/[^0-9]/g, '') : '';
                        if (!targetNumber) {
                            return sendPhotoResponse(sock, from, '⚠️ Masukkan nomor!\nContoh: *.masukin 628xxxxxxxxxx*', msg);
                        }

                        const targetJid = targetNumber + '@s.whatsapp.net';
                        const response = await sock.groupParticipantsUpdate(from, [targetJid], 'add');
                        
                        if (response && response[0]?.status === '403') {
                            await sendPhotoResponse(sock, from, '❌ Gagal menambahkan! Target membatasi privasi undangan grup.', msg);
                        } else {
                            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        }
                    }

                    else if (command === '.ewein' || command === '.promote' || command === '.demote') {
                        const contextInfo = messageContent.extendedTextMessage?.contextInfo;
                        let targetJid = contextInfo?.mentionedJid?.[0];

                        const cleanNumFromInput = textInput.replace(/[^0-9]/g, '');
                        if (!targetJid && cleanNumFromInput) {
                            targetJid = cleanNumFromInput + '@s.whatsapp.net';
                        }

                        if (!targetJid && contextInfo?.participant && !contextInfo.participant.endsWith('@g.us')) {
                            targetJid = contextInfo.participant;
                        }

                        if (!targetJid) {
                            return sendPhotoResponse(sock, from, `⚠️ Tag atau reply member yang ingin di-${command.replace('.', '')}!`, msg);
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
                    await sendPhotoResponse(sock, from, '❌ Gagal mengeksekusi perintah. Pastikan bot berstatus *Admin*!', msg);
                }
            }

        } catch (err) {
            console.error('Error Message Upsert:', err);
        }
    });
} 

connectToWhatsApp();
