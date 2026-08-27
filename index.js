// FITUR .KICK (Khusus Admin Grup & Owner)
else if (command === '.kick') {
    if (!isGroup) {
        await sock.sendMessage(from, { text: '⚠️ Fitur ini khusus di dalam grup!' }, { quoted: msg });
        return;
    }

    const groupMetadata = await sock.groupMetadata(from);
    const participants = groupMetadata.participants;
    
    const participant = participants.find(p => p.id === rawSender || p.id.split('@')[0] === senderNumber);
    const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

    if (!isAdmin && !isOwner) {
        await sock.sendMessage(from, { text: '❌ Perintah ini hanya dapat digunakan oleh *Admin Grup*!' }, { quoted: msg });
        return;
    }

    const botJid = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
    const botPart = participants.find(p => p.id === botJid || p.id === sock.user.id || p.id.startsWith(sock.user.id.split('@')[0]));
    const isBotAdmin = botPart && (botPart.admin === 'admin' || botPart.admin === 'superadmin');

    if (!isBotAdmin) {
        await sock.sendMessage(from, { text: '❌ Gagal! Bot harus dijadikan *Admin Grup* terlebih dahulu.' }, { quoted: msg });
        return;
    }

    // Perbaikan: Deteksi target lebih akurat baik dari mention, reply, maupun argumen teks
    const quoted = msg.message.extendedTextMessage?.contextInfo;
    let targetUser = quoted?.mentionedJid?.[0] || quoted?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
    
    if (!targetUser) {
        await sock.sendMessage(from, { text: '⚠️ Silakan tag, reply, atau masukkan nomor orang yang ingin dikeluarkan dari grup!' }, { quoted: msg });
        return;
    }

    try {
        await sock.groupParticipantsUpdate(from, [targetUser], 'remove');
        await sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan @${targetUser.split('@')[0]} dari grup.`, mentions: [targetUser] }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(from, { text: `❌ Gagal mengeluarkan user. Pastikan nomor valid atau bot memiliki hak akses.` }, { quoted: msg });
    }
}
