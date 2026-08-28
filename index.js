const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const axios = require('axios');
const fs = require('fs');

// ==========================================
// KONFIGURASI OWNER & VIP
// ==========================================
const OWNER_NUMBERS = ['6281298697777']; // Masukkan nomor owner di sini
const VIP_NUMBERS = ['6285722869044', '6285722256098', '6282126168799'];     // Masukkan nomor VIP agar tetap bisa akses saat private

// FILE LOKAL UNTUK MENYIMPAN SETTINGAN & DATABASE
const SETTINGS_FILE = 'bot_settings.json';
const DB_VERIF_FILE = 'verified_users.json';
const DB_RPG_FILE = 'rpg.json';

// Fungsi membaca settingan bot
const loadSettings = () => {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            return parsed.isPublicMode !== undefined ? parsed.isPublicMode : true;
        }
    } catch (e) {
        console.error('Gagal membaca settingan:', e);
    }
    return true;
};

// Fungsi menyimpan settingan bot
const saveSettings = (isPublic) => {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ isPublicMode: isPublic }, null, 2));
    } catch (e) {
        console.error('Gagal menyimpan settingan:', e);
    }
};

let isPublicMode = true;

// Fungsi membaca database verifikasi TikTok
const loadDatabase = () => {
    try {
        if (fs.existsSync(DB_VERIF_FILE)) {
            const data = fs.readFileSync(DB_VERIF_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Gagal membaca database verif:', e);
    }
    return {};
};

const saveDatabase = (db) => {
    try {
        fs.writeFileSync(DB_VERIF_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error('Gagal menyimpan database verif:', e);
    }
};

// Fungsi Database RPG
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

// Helper presisi mengekstrak digit angka saja
const extractNumber = (jid) => {
    if (!jid || typeof jid !== 'string') return '';
    const clean = jid.split('@')[0].split(':')[0];
    return clean.replace(/[^0-9]/g, '');
};

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
            console.log('✅ Bot WhatsApp (Baileys) SIAP DIGUNAKAN!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const senderNumber = extractNumber(senderJid);

        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || 
                     msg.message.videoMessage?.caption || '';

        if (!text) return;
        const args = text.trim().split(/ +/);
        const command = args.shift().toLowerCase();

        const isOwner = msg.key.fromMe || OWNER_NUMBERS.includes(senderNumber);
        const isVIP = VIP_NUMBERS.includes(senderNumber);

        // ==========================================
        // FITUR MODE ACCESS (.private & .publik)
        // ==========================================
        if (command === '.private' || command === '.self') {
            if (!isOwner) return sock.sendMessage(from, { text: '❌ Perintah ini hanya untuk *Owner Bot*!' }, { quoted: msg });
            isPublicMode = false;
            saveSettings(isPublicMode);
            return sock.sendMessage(from, { text: '🔒 Bot berhasil diubah ke *MODE PRIVATE*.\n\nHanya Owner dan daftar nomor VIP yang dapat menggunakan bot.' }, { quoted: msg });
        } 
        else if (command === '.publik' || command === '.public') {
            if (!isOwner) return sock.sendMessage(from, { text: '❌ Perintah ini hanya untuk *Owner Bot*!' }, { quoted: msg });
            isPublicMode = true;
            saveSettings(isPublicMode);
            return sock.sendMessage(from, { text: '🌐 Bot berhasil diubah ke *MODE PUBLIK*.' }, { quoted: msg });
        }

        // KUNCI UTAMA: Jika mode private, abaikan jika bukan Owner dan bukan VIP
        if (!isPublicMode && !isOwner && !isVIP) return;

        // ==========================================
        // FITUR MENU & PING
        // ==========================================
        if (command === '.menu' || command === '.help') {
            const statusMode = isPublicMode ? '🌐 PUBLIK' : '🔒 PRIVATE';
            const menuText = 
`🤖 *BOT RIQ IMUP😳*
📊 *Status Bot:* ${statusMode}

📌 *PERINTAH UTAMA*
* ➔ *.menu* : Menampilkan menu
* ➔ *.ping* : Cek kecepatan respon bot

🎨 *STIKER & MEDIA*
* ➔ *.stiker* / *.s* : Kirim/reply foto jadi stiker
* ➔ *.wm <pack> | <author>* : Ubah watermark stiker
* ➔ *.rvo* : Reply foto/video sekali lihat (view once)

👥 *GRUP & FITUR SPESIAL*
* ➔ *.ah <pesan> / reply* : Hidetag (Mention seluruh member)
* ➔ *.masukin +62 831-6609-3861* : Menambahkan member ke grup
* ➔ *.ewein @user* : Mengeluarkan member dari grup
* ➔ *.promote / .demote @user* : Atur admin grup

🎵 *VERIFIKASI TIKTOK*
* ➔ *.verif <username>* : Verifikasi akun TikTok (Maks 1)
* ➔ *.unverif* : Batalkan verifikasi akun TikTok

⚔️ *GAME RPG*
* ➔ *.rpg* / *.status* / *.profile* : Cek profil karakter RPG
* ➔ *.pilihjob <warrior/mage/archer>* : Memilih job karakter
* ➔ *.adventure* / *.hunt* : Berburu monster & cari EXP/Gold
* ➔ *.heal* : Memulihkan HP karakter
* ➔ *.leaderboard* / *.toprpg* : Peringkat pemain RPG teratas`;

            await sock.sendMessage(from, { text: menuText }, { quoted: msg });
        } 
        else if (command === '.ping') {
            const start = Date.now();
            await sock.sendMessage(from, { text: `🏓 *Pong!*\n⚡ Kecepatan respon: *${Date.now() - start} ms*` }, { quoted: msg });
        }

        // ==========================================
        // FITUR STIKER (.sticker / .stiker / .s)
        // ==========================================
        else if (command === '.sticker' || command === '.stiker' || command === '.s') {
            try {
                const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                const qMsg = contextInfo?.quotedMessage;
                const isDirectImage = msg.message.imageMessage;
                
                let quotedImageMsg = qMsg?.imageMessage || 
                                     qMsg?.ephemeralMessage?.message?.imageMessage || 
                                     qMsg?.viewOnceMessage?.message?.imageMessage ||
                                     qMsg?.viewOnceMessageV2?.message?.imageMessage;

                if (!isDirectImage && !quotedImageMsg) {
                    return sock.sendMessage(from, { text: '⚠️ Kirim foto dengan caption *.stiker* atau reply foto yang ingin dijadikan stiker!' }, { quoted: msg });
                }

                await sock.sendMessage(from, { text: '⏳ Sedang membuat stiker...' }, { quoted: msg });

                let mediaTarget = msg;
                if (quotedImageMsg) {
                    mediaTarget = {
                        key: {
                            remoteJid: from,
                            fromMe: false,
                            id: contextInfo.stanzaId,
                            participant: contextInfo.participant || from
                        },
                        message: qMsg
                    };
                }

                let mediaBuffer = await downloadMediaMessage(mediaTarget, 'buffer', {});

                if (!mediaBuffer || mediaBuffer.length === 0) {
                    throw new Error('Buffer kosong.');
                }

                const sticker = new Sticker(mediaBuffer, {
                    pack: '',
                    author: '',
                    type: StickerTypes.FULL,
                    quality: 70
                });

                const stickerBuffer = await sticker.toBuffer();
                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });

            } catch (err) {
                console.error('Error Sticker Detail:', err);
                await sock.sendMessage(from, { text: '❌ Gagal membuat stiker. Pastikan media berupa foto valid!' }, { quoted: msg });
            }
        }

        // ==========================================
        // FITUR WATERMARK STIKER (.wm)
        // ==========================================
        else if (command === '.wm' || command === '.watermark') {
            try {
                const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                const qMsg = contextInfo?.quotedMessage;

                let quotedStickerMsg = qMsg?.stickerMessage || 
                                       qMsg?.ephemeralMessage?.message?.stickerMessage;

                if (!quotedStickerMsg) {
                    return sock.sendMessage(from, { text: '⚠️ Reply stiker yang ingin diubah watermark-nya!\nContoh: *.wm Packname | Author*' }, { quoted: msg });
                }

                const input = args.join(' ');
                const [packName, authorName] = input.split('|').map(str => str ? str.trim() : '');

                const finalPack = packName || 'Created By';
                const finalAuthor = authorName || 'My Bot';

                await sock.sendMessage(from, { text: '⏳ Memproses ubah watermark...' }, { quoted: msg });

                const mediaTarget = {
                    key: {
                        remoteJid: from,
                        fromMe: false,
                        id: contextInfo.stanzaId,
                        participant: contextInfo.participant || from
                    },
                    message: qMsg
                };

                const mediaBuffer = await downloadMediaMessage(mediaTarget, 'buffer', {});

                if (!mediaBuffer || mediaBuffer.length === 0) {
                    throw new Error('Buffer stiker kosong.');
                }

                const sticker = new Sticker(mediaBuffer, {
                    pack: finalPack,
                    author: finalAuthor,
                    type: StickerTypes.FULL,
                    quality: 70
                });

                const stickerBuffer = await sticker.toBuffer();
                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });

            } catch (err) {
                console.error('Error Watermark Detail:', err);
                await sock.sendMessage(from, { text: '❌ Gagal mengubah watermark stiker. Pastikan stiker yang di-reply adalah stiker statis!' }, { quoted: msg });
            }
        }

        // ==========================================
        // FITUR READ VIEW ONCE (.rvo)
        // ==========================================
        else if (command === '.rvo' || command === '.readviewonce') {
            try {
                const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                const qMsg = contextInfo?.quotedMessage;

                if (!qMsg) {
                    return sock.sendMessage(from, { text: '⚠️ Reply foto atau video sekali lihat (view once) yang ingin dibuka!' }, { quoted: msg });
                }

                const viewOnceMsg = qMsg.viewOnceMessage?.message || 
                                    qMsg.viewOnceMessageV2?.message || 
                                    qMsg.ephemeralMessage?.message?.viewOnceMessage?.message ||
                                    qMsg.ephemeralMessage?.message?.viewOnceMessageV2?.message;

                const mediaMessage = viewOnceMsg?.imageMessage || 
                                     viewOnceMsg?.videoMessage || 
                                     qMsg.imageMessage || 
                                     qMsg.videoMessage;

                if (!mediaMessage) {
                    return sock.sendMessage(from, { text: '❌ Pesan yang kamu reply bukan media *View Once* (Sekali Lihat) yang valid!' }, { quoted: msg });
                }

                await sock.sendMessage(from, { text: '⏳ Mengambil media view once...' }, { quoted: msg });

                const mediaTarget = {
                    key: {
                        remoteJid: from,
                        fromMe: false,
                        id: contextInfo.stanzaId,
                        participant: contextInfo.participant || from
                    },
                    message: qMsg
                };

                const mediaBuffer = await downloadMediaMessage(mediaTarget, 'buffer', {});

                if (!mediaBuffer || mediaBuffer.length === 0) {
                    throw new Error('Buffer media kosong.');
                }

                const caption = mediaMessage.caption || 'Nih pesan view once-nya berhasil dibongkar 🔓';

                if (mediaMessage.mimetype && mediaMessage.mimetype.includes('video')) {
                    await sock.sendMessage(from, { video: mediaBuffer, caption: caption }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { image: mediaBuffer, caption: caption }, { quoted: msg });
                }

            } catch (err) {
                console.error('Error RVO Detail:', err);
                await sock.sendMessage(from, { text: '❌ Gagal membuka pesan View Once. Pastikan kamu mereply pesan sekali lihat dengan benar!' }, { quoted: msg });
            }
        }

        // ==========================================
        // FITUR HIDETAG (.ah)
        // ==========================================
        else if (command === '.ah' || command === '.hidetag') {
            if (!isGroup) {
                return sock.sendMessage(from, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
            }

            try {
                const groupMetadata = await sock.groupMetadata(from);
                const participants = groupMetadata.participants || [];
                const adminParticipants = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
                const adminNumbers = adminParticipants.map(p => extractNumber(p.id));

                const isSenderAdmin = adminNumbers.includes(senderNumber);

                if (!isSenderAdmin && !isOwner && !isVIP) {
                    return sock.sendMessage(from, { text: '❌ Perintah ini khusus untuk *Admin Grup*, *Owner*, atau *VIP*!' }, { quoted: msg });
                }

                const qMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                const quotedText = qMsg?.conversation || 
                                   qMsg?.extendedTextMessage?.text || 
                                   qMsg?.imageMessage?.caption || 
                                   qMsg?.videoMessage?.caption || '';

                const directText = args.join(' ');
                const finalHidetagText = directText || quotedText;

                if (!finalHidetagText) {
                    return sock.sendMessage(from, { text: '⚠️ Masukkan teks atau reply pesan yang ingin dijadikan hidetag!\nContoh: *.ah Pengumuman*' }, { quoted: msg });
                }

                const allMembers = participants.map(p => p.id);
                await sock.sendMessage(from, { text: finalHidetagText, mentions: allMembers }, { quoted: msg });

            } catch (err) {
                console.error('Error Hidetag Detail:', err);
                await sock.sendMessage(from, { text: '❌ Gagal mengeksekusi fitur hidetag.' }, { quoted: msg });
            }
        }

        // ==========================================
        // FITUR VERIFIKASI TIKTOK (.verif) - MAX 1 AKUN
        // ==========================================
        else if (command === '.verif' || command === '.veriftiktok' || command === '.ttverif') {
            let db = loadDatabase();

            if (db[senderNumber]) {
                return sock.sendMessage(from, { 
                    text: `⚠️ *GAGAL VERIFIKASI*\n\nKamu sudah memverifikasi akun TikTok *@${db[senderNumber]}*.\n\nSatu nomor WhatsApp hanya dapat memverifikasi *1 akun TikTok*. Ketik *.unverif* jika ingin mengganti.` 
                }, { quoted: msg });
            }

            const username = args[0]?.replace('@', '');
            if (!username) {
                return sock.sendMessage(from, { text: '⚠️ Masukkan username TikTok!\nContoh: *.verif zann_dim*' }, { quoted: msg });
            }

            await sock.sendMessage(from, { text: `🔍 Memeriksa data akun TikTok *@${username}*...` }, { quoted: msg });

            const RAPIDAPI_KEY = '62743950e0mshbfd3b40a5d4bd01p10e681jsn956f79b5b429';
            const RAPIDAPI_HOST = 'tiktok-api23.p.rapidapi.com';

            try {
                const response = await axios.get(`https://${RAPIDAPI_HOST}/api/user/info`, {
                    params: { uniqueId: username },
                    headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST },
                    timeout: 10000
                });

                const resData = response.data;
                const userInfo = resData?.userInfo || resData?.data || resData || {};
                const user = userInfo?.user || {};
                const stats = userInfo?.stats || {};

                const targetUsername = user.uniqueId || username;
                const nickname = user.nickname || targetUsername;
                const followers = stats.followerCount !== undefined ? Number(stats.followerCount).toLocaleString('id-ID') : '-';
                const bio = user.signature || '-';
                const totalVideo = stats.videoCount !== undefined ? Number(stats.videoCount).toLocaleString('id-ID') : '-';
                const totalLikes = stats.heartCount !== undefined ? Number(stats.heartCount).toLocaleString('id-ID') : '-';
                
                const createTime = user.createTime 
                    ? new Date(user.createTime * 1000).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
                    : 'Tidak publik';

                db[senderNumber] = targetUsername;
                saveDatabase(db);

                const captionText = 
`✅ *BERHASIL TERVERIFIKASI*

🎵 *INFORMASI AKUN TIKTOK*
📛 *Display Name:* ${nickname}
👤 *Username:* @${targetUsername}
👥 *Follower:* ${followers}
📝 *Bio:* ${bio}
📅 *Since Akun:* ${createTime}
🎥 *Total Video:* ${totalVideo}
❤️ *Total Likes:* ${totalLikes}
🔗 *Link:* https://www.tiktok.com/@${targetUsername}`;

                const avatar = user.avatarMedium || user.avatarLarger || user.avatarThumb;
                if (avatar) {
                    await sock.sendMessage(from, { image: { url: avatar }, caption: captionText }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: captionText }, { quoted: msg });
                }

            } catch (error) {
                console.error('RapidAPI Error:', error?.message);
                db[senderNumber] = username;
                saveDatabase(db);
                await sock.sendMessage(from, { text: `🎵 *Akun TikTok:* @${username}\n🔗 https://www.tiktok.com/@${username}\n\n✅ Berhasil diverifikasi (Fallback Mode).` }, { quoted: msg });
            }
        }

        // ==========================================
        // FITUR UNVERIFIKASI (.unverif)
        // ==========================================
        else if (command === '.unverif') {
            let db = loadDatabase();
            if (!db[senderNumber]) {
                return sock.sendMessage(from, { text: '⚠️ Kamu belum memiliki akun TikTok yang terverifikasi.' }, { quoted: msg });
            }
            const oldUsername = db[senderNumber];
            delete db[senderNumber];
            saveDatabase(db);
            await sock.sendMessage(from, { text: `🗑️ Verifikasi untuk *@${oldUsername}* telah dihapus. Sekarang kamu bisa menggunakan *.verif* untuk akun lain.` }, { quoted: msg });
        }

        // ==========================================
        // FITUR RPG (Role-Playing Game)
        // ==========================================
        else if (['rpg', 'status', 'profile', 'pilihjob', 'adventure', 'hunt', 'heal', 'leaderboard', 'toprpg'].includes(command)) {
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

            if (command === 'rpg' || command === 'status' || command === 'profile') {
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
            } 
            else if (command === 'pilihjob') {
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
                await sock.sendMessage(from, { text: `🎉 Berhasil memilih job *${player.job.toUpperCase()}*!` }, { quoted: msg });
            }
            else if (command === 'adventure' || command === 'hunt') {
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
            }
            else if (command === 'heal') {
                let cost = 20;
                if (player.gold < cost) return sock.sendMessage(from, { text: `💰 Gold kurang! Biaya heal ${cost} Gold.` }, { quoted: msg });
                if (player.hp === player.maxHp) return sock.sendMessage(from, { text: `❤️ HP sudah penuh!` }, { quoted: msg });

                player.gold -= cost;
                player.hp = player.maxHp;
                saveRpgDb(rpgDb);
                await sock.sendMessage(from, { text: `🏥 Berhasil berobat seharga ${cost} Gold. HP kembali penuh!` }, { quoted: msg });
            }
            else if (command === 'leaderboard' || command === 'toprpg') {
                let sorted = Object.values(rpgDb).sort((a, b) => b.level - a.level || b.gold - a.gold).slice(0, 5);
                let text = `🏆 *TOP 5 LEADERBOARD RPG* 🏆\n\n`;
                sorted.forEach((p, i) => {
                    text += `${i + 1}. *${p.name}* | Lv: ${p.level} | Gold: ${p.gold} (${p.job ? p.job.toUpperCase() : 'No Job'})\n`;
                });
                await sock.sendMessage(from, { text: text }, { quoted: msg });
            }
        }

        // ==========================================
        // FITUR GRUP (.masukin, .ewein, .promote, .demote)
        // ==========================================
        else if (['.masukin', '.ewein', '.promote', '.demote'].includes(command)) {
            if (!isGroup) {
                return sock.sendMessage(from, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
            }

            try {
                const groupMetadata = await sock.groupMetadata(from);
                const participants = groupMetadata.participants || [];
                const adminParticipants = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
                const adminNumbers = adminParticipants.map(p => extractNumber(p.id));

                const isSenderAdmin = adminNumbers.includes(senderNumber);

                if (!isSenderAdmin && !isOwner) {
                    return sock.sendMessage(from, { text: '❌ Perintah ini khusus untuk *Admin Grup* atau *Owner*!' }, { quoted: msg });
                }

                // Handler khusus untuk fitur .masukin dengan dukungan format +62 831-6609-3861
                if (command === '.masukin') {
                    // Mengambil seluruh argumen setelah .masukin lalu membuang semua karakter selain angka
                    const fullArgs = args.join('');
                    const targetNumberInput = fullArgs.replace(/[^0-9]/g, '');

                    if (!targetNumberInput || targetNumberInput.length < 10) {
                        return sock.sendMessage(from, { text: '⚠️ Masukkan nomor dengan benar!\nContoh: *.masukin +62 831-6609-3861*' }, { quoted: msg });
                    }

                    const targetJid = targetNumberInput + '@s.whatsapp.net';
                    
                    try {
                        const response = await sock.groupParticipantsUpdate(from, [targetJid], 'add');
                        const resObj = response?.[0] || response;
                        
                        if (resObj && resObj.status >= 400) {
                            return sock.sendMessage(from, { text: `❌ Gagal menambahkan member. WhatsApp membatasi penambahan jika user mengaktifkan privasi atau baru saja keluar.` }, { quoted: msg });
                        }

                        await sock.sendMessage(from, { text: `✅ Berhasil menambahkan @${targetNumberInput} ke dalam grup.`, mentions: [targetJid] }, { quoted: msg });
                    } catch (addErr) {
                        console.error('Error Masukin Participant:', addErr);
                        await sock.sendMessage(from, { text: '❌ Gagal menambahkan member. Pastikan nomor valid dan menggunakan format kode negara.' }, { quoted: msg });
                    }
                    return;
                }

                // Handler untuk .ewein, .promote, .demote
                let targetJid = null;
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
                const quotedSender = msg.message.extendedTextMessage?.contextInfo?.participant;

                if (mentioned && mentioned.length > 0) {
                    targetJid = mentioned[0];
                } else if (quotedSender) {
                    targetJid = quotedSender;
                }

                if (!targetJid) {
                    return sock.sendMessage(from, { text: `⚠️ Penggunaan salah!\nContoh: *${command} @user*` }, { quoted: msg });
                }

                const targetNumber = extractNumber(targetJid);

                if (command === '.ewein') {
                    await sock.groupParticipantsUpdate(from, [targetJid], 'remove');
                    await sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan @${targetNumber}.`, mentions: [targetJid] }, { quoted: msg });
                } 
                else if (command === '.promote') {
                    await sock.groupParticipantsUpdate(from, [targetJid], 'promote');
                    await sock.sendMessage(from, { text: `✅ Berhasil menaikkan @${targetNumber} menjadi Admin.`, mentions: [targetJid] }, { quoted: msg });
                } 
                else if (command === '.demote') {
                    await sock.groupParticipantsUpdate(from, [targetJid], 'demote');
                    await sock.sendMessage(from, { text: `✅ Berhasil menurunkan posisi Admin @${targetNumber}.`, mentions: [targetJid] }, { quoted: msg });
                }
            } catch (err) {
                console.error('Error Admin Feature:', err);
                await sock.sendMessage(from, { text: '❌ Gagal mengeksekusi perintah. Pastikan bot adalah Admin Grup!' }, { quoted: msg });
            }
        }
    });
}

connectToWhatsApp();
