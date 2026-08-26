const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const axios = require('axios');
const cheerio = require('cheerio');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const listBolehKick = ['6281298697777'];

const listNickTikTok = [
    "𝙕 𝙚 𝙣 𝙣", "𝐕 𝐞 𝐱 𝐱", " 𝙖 𝙞 𝙯 𝙤", "𝕽 𝖞 𝖚 𝖟 𝖆 𝖐 𝖎",
    "C L O U D", "S H A D O W", "KGY", "Æ · Skyee",
    "々 · A l e x", "V a n x y z", "𝕯 𝖆 𝖗 𝖐", "𝙁 𝙡 𝙖 𝙢 𝑒",
    "✦ · N o v a", "𝙆 𝙮 𝙤"
];

function formatNumber(num) {
    if (!num) return '0';
    return Number(num).toLocaleString('id-ID');
}

// Helper Konversi Foto Ke Stiker (Bypass Sharp via FFmpeg)
async function imageToSticker(buffer) {
    const tmpInput = path.join(__dirname, `tmp_${Date.now()}.jpg`);
    const tmpOutput = path.join(__dirname, `tmp_${Date.now()}.webp`);
    
    fs.writeFileSync(tmpInput, buffer);

    return new Promise((resolve, reject) => {
        ffmpeg(tmpInput)
            .outputOptions([
                '-vcodec libwebp',
                '-vf scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
            ])
            .toFormat('webp')
            .save(tmpOutput)
            .on('end', () => {
                const stickerBuf = fs.readFileSync(tmpOutput);
                if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
                if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
                resolve(stickerBuf);
            })
            .on('error', (err) => {
                if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
                if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
                reject(err);
            });
    });
}

// Scraper TikTok Multi-Server
async function getTikTokProfile(username) {
    const cleanUser = username.replace('@', '').trim();

    try {
        const response = await axios.get(`https://www.tiktok.com/@${cleanUser}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 8000
        });

        const $ = cheerio.load(response.data);
        const jsonScript = $('#__UNIVERSAL_DATA_FOR_REHYDRATION__').html();

        if (jsonScript) {
            const parsedData = JSON.parse(jsonScript);
            const userDetail = parsedData['__DEFAULT_SCOPE__']?.['webapp.user-detail'];

            if (userDetail && userDetail.userInfo) {
                const u = userDetail.userInfo.user;
                const s = userDetail.userInfo.stats;

                return {
                    status: true,
                    nickname: u.nickname || cleanUser,
                    username: u.uniqueId || cleanUser,
                    avatar: u.avatarLarger || u.avatarMedium || u.avatarThumb,
                    followers: formatNumber(s.followerCount),
                    videoCount: formatNumber(s.videoCount),
                    bio: u.signature || 'Tidak ada bio',
                    createDate: u.createTime ? new Date(u.createTime * 1000).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Terverifikasi Aktif'
                };
            }
        }
    } catch (e) {}

    try {
        const res = await axios.get(`https://api.vreden.web.id/api/tiktokstalk?username=${cleanUser}`, { timeout: 8000 });
        if (res.data && res.data.result) {
            const data = res.data.result;
            return {
                status: true,
                nickname: data.nickname || cleanUser,
                username: data.username || cleanUser,
                avatar: data.avatar || data.profile,
                followers: formatNumber(data.followers || data.follower),
                videoCount: formatNumber(data.video || data.videos),
                bio: data.bio || data.signature || 'Tidak ada bio',
                createDate: 'Terverifikasi System'
            };
        }
    } catch (e) {}

    return { status: false };
}

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
        // Mencegah balasan ganda pada pesan lawas
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');

            const rawSender = msg.key.participant || msg.participant || msg.key.remoteJid || '';
            const senderNumber = rawSender.split('@')[0].replace(/[^0-9]/g, '');

            const body = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || 
                         msg.message.videoMessage?.caption || '';
            
            const pesan = body.trim();
            if (!pesan.startsWith('.')) continue; // Hanya proses jika diawali titik

            const command = pesan.toLowerCase().split(' ')[0];

            // 1. FITUR .PING (Mencegah double respon)
            if (command === '.ping') {
                const latency = Date.now() - (msg.messageTimestamp * 1000);
                const speed = latency < 0 ? 0 : latency;
                await sock.sendMessage(from, { text: `🏓 *Pong!*\n⚡ Kecepatan respon: *${speed} ms*` }, { quoted: msg });
            } 

            // 2. FITUR .STIKER / .S / .WM (Perbaikan reply foto & watermark)
            else if (command === '.stiker' || command === '.s' || command === '.wm') {
                try {
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const isImage = msg.message.imageMessage;
                    const isQuotedImage = quotedMsg?.imageMessage;

                    if (!isImage && !isQuotedImage) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim foto dengan caption *.stiker* atau reply foto yang ingin dijadikan stiker!' }, { quoted: msg });
                        return;
                    }

                    let mediaToDownload;
                    if (isQuotedImage) {
                        mediaToDownload = {
                            key: {
                                remoteJid: from,
                                id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                                participant: msg.message.extendedTextMessage.contextInfo.participant
                            },
                            message: quotedMsg
                        };
                    } else {
                        mediaToDownload = msg;
                    }

                    const buffer = await downloadMediaMessage(mediaToDownload, 'buffer', {});
                    const stickerBuffer = await imageToSticker(buffer);

                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
                } catch (err) {
                    console.error('Error stiker:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal membuat stiker. Pastikan media berupa foto!' }, { quoted: msg });
                }
            }

            // 3. FITUR .LISTMEM
            else if (command === '.listmem') {
                if (!isGroup) {
                    await sock.sendMessage(from, { text: '⚠️ Fitur ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    return;
                }
                try {
                    const groupMetadata = await sock.groupMetadata(from);
                    const participants = groupMetadata.participants;

                    let teksBalas = `📋 *DAFTAR MEMBER GRUP*\n👥 Total: *${participants.length} Member*\n\n`;
                    let mentions = [];

                    for (let mem of participants) {
                        teksBalas += `@${mem.id.split('@')[0]}\n`;
                        mentions.push(mem.id);
                    }

                    await sock.sendMessage(from, { text: teksBalas, mentions: mentions }, { quoted: msg });
                } catch (err) {
                    console.error('Error listmem:', err);
                }
            }

            // 4. FITUR .KICK
            else if (command === '.kick') {
                if (!isGroup) {
                    await sock.sendMessage(from, { text: '⚠️ Fitur ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    return;
                }

                const isFromMe = msg.key.fromMe;
                const punyaIzin = isFromMe || listBolehKick.includes(senderNumber);

                if (!punyaIzin) {
                    await sock.sendMessage(from, { text: '❌ Anda tidak memiliki izin untuk menggunakan perintah .kick!' }, { quoted: msg });
                    return;
                }

                try {
                    let targetUser = '';
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const mentionedJid = contextInfo?.mentionedJid;
                    const quotedParticipant = contextInfo?.participant;

                    if (mentionedJid && mentionedJid.length > 0) {
                        targetUser = mentionedJid[0];
                    } else if (quotedParticipant) {
                        targetUser = quotedParticipant;
                    }

                    if (!targetUser) {
                        await sock.sendMessage(from, { text: '⚠️ Tag orang yang ingin di-kick atau reply pesannya!\n\nContoh:\n*.kick @user*' }, { quoted: msg });
                        return;
                    }

                    await sock.groupParticipantsUpdate(from, [targetUser], 'remove');
                    await sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan @${targetUser.split('@')[0]} dari grup!`, mentions: [targetUser] }, { quoted: msg });

                } catch (err) {
                    console.error('Error kick:', err);
                    await sock.sendMessage(from, { text: '❌ Gagal mengeluarkan member. Pastikan **Bot sudah diangkat menjadi Admin grup**!' }, { quoted: msg });
                }
            }

            // 5. FITUR .CN
            else if (command === '.cn') {
                try {
                    const args = pesan.split(' ').slice(1);
                    const param = args.join(' ').trim();

                    if (!param) {
                        let teks = `CN (copy aja)\n`;
                        for (let i = 0; i < listNickTikTok.length; i++) {
                            teks += `${i + 1}. ${listNickTikTok[i]}\n`;
                        }
                        teks += `\npilih salah satu aja ya (contoh: .cn 1)`;
                        await sock.sendMessage(from, { text: teks }, { quoted: msg });
                        return;
                    }

                    let selectedNick = '';
                    const nickIndex = parseInt(param) - 1;

                    if (!isNaN(nickIndex) && listNickTikTok[nickIndex]) {
                        selectedNick = listNickTikTok[nickIndex];
                    } else {
                        const foundNick = listNickTikTok.find(n => n.toLowerCase().includes(param.toLowerCase()));
                        if (foundNick) selectedNick = foundNick;
                    }

                    if (selectedNick) {
                        await sock.sendMessage(from, { text: selectedNick }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: `❌ Nickname nomor *"${param}"* tidak ditemukan!` }, { quoted: msg });
                    }

                } catch (err) {
                    console.error('Error .cn:', err);
                }
            }

            // 6. FITUR .VERIF
            else if (command === '.verif' || command === '.verifikasi') {
                try {
                    const args = pesan.split(' ').slice(1);
                    const usernameInput = args.join(' ').trim();

                    if (!usernameInput) {
                        await sock.sendMessage(from, { text: `⚠️ *Format Verifikasi Salah!*\n\nContoh:\n*.verif moenzyy7*` }, { quoted: msg });
                        return;
                    }

                    const cleanUsername = usernameInput.replace('@', '');
                    await sock.sendMessage(from, { text: '⏳ *Sedang memverifikasi data akun TikTok...*' }, { quoted: msg });

                    const profile = await getTikTokProfile(cleanUsername);

                    if (profile.status) {
                        let caption = `✅ *VERIFIKASI AKUN TIKTOK BERHASIL*\n\n`;
                        caption += `📛 *Display Name:* ${profile.nickname}\n`;
                        caption += `🆔 *Username:* @${profile.username}\n`;
                        caption += `👥 *Followers:* ${profile.followers}\n`;
                        caption += `🎬 *Total Video:* ${profile.videoCount}\n`;
                        caption += `📅 *Akun Dibuat:* ${profile.createDate}\n`;
                        caption += `📝 *Bio:* ${profile.bio}\n\n`;
                        caption += `👤 *Diverifikasi Oleh:* @${senderNumber}\n`;
                        caption += `✨ Status: *AKUN RESMI TERVERIFIKASI*`;

                        await sock.sendMessage(from, { 
                            image: { url: profile.avatar },
                            caption: caption,
                            mentions: [rawSender]
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { 
                            text: `❌ *Gagal mengambil data akun TikTok "${cleanUsername}".*\nPastikan username benar dan akun tidak di-private.` 
                        }, { quoted: msg });
                    }

                } catch (err) {
                    console.error('Error verif:', err);
                    await sock.sendMessage(from, { text: '❌ Terjadi kesalahan sistem saat verifikasi.' }, { quoted: msg });
                }
            }
        }
    });
}

startBot();
