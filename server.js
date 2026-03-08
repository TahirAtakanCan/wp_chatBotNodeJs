const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── İstek Zaman Aşımı Middleware ────────────────────────────────────
app.use((req, res, next) => {
    res.setTimeout(90000, () => {
        if (!res.headersSent) {
            res.status(504).json({ success: false, error: 'İstek zaman aşımına uğradı (90s)' });
        }
    });
    next();
});

// ── Multi-Session Yönetimi ──────────────────────────────────────────
// Her session: { sock, currentQR, isConnected, connectedUser, isClientReady, isRestarting, authDir }
const sessions = new Map();

const SESSIONS_ROOT = path.join(__dirname, 'sessions');
const logger = pino({ level: 'silent' });

// sessions klasörü yoksa oluştur
if (!fs.existsSync(SESSIONS_ROOT)) {
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
}

// ── Tek Bir Session Başlat ──────────────────────────────────────────
async function createSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isClientReady || existing.isRestarting) {
            console.log(`[${sessionId}] Zaten aktif veya başlatılıyor.`);
            return;
        }
    }

    const authDir = path.join(SESSIONS_ROOT, sessionId);
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    // Session state'ini başlangıç değerleriyle kaydet
    const sessionState = {
        sock: null,
        currentQR: null,
        isConnected: false,
        connectedUser: null,
        isClientReady: false,
        isRestarting: true,
        authDir,
    };
    sessions.set(sessionId, sessionState);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            printQRInTerminal: false,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
        });

        sessionState.sock = sock;

        // Kimlik bilgilerini kaydet
        sock.ev.on('creds.update', saveCreds);

        // Bağlantı durumu
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionState.currentQR = qr;
                sessionState.isConnected = false;
                console.log(`[${sessionId}] QR kodu güncellendi — /session/${sessionId}/status`);
            }

            if (connection === 'open') {
                sessionState.isClientReady = true;
                sessionState.isRestarting = false;
                sessionState.isConnected = true;
                sessionState.connectedUser = sock.user?.name || sock.user?.id || null;
                sessionState.currentQR = null;
                console.log(`[${sessionId}] ✅ Bağlandı! Kullanıcı: ${sessionState.connectedUser}`);
            }

            if (connection === 'close') {
                sessionState.isClientReady = false;
                sessionState.isRestarting = false;
                sessionState.isConnected = false;
                sessionState.connectedUser = null;

                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode
                    : lastDisconnect?.error?.output?.statusCode;

                console.warn(`[${sessionId}] 🔌 Bağlantı kapandı (kod: ${statusCode || '?'}).`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`[${sessionId}] 🗑️ Oturum kapatıldı — auth temizleniyor...`);
                    if (fs.existsSync(authDir)) {
                        fs.rmSync(authDir, { recursive: true, force: true });
                    }
                    sessions.delete(sessionId);
                    console.log(`[${sessionId}] Session silindi.`);
                    return;
                }

                // Yeniden bağlan
                console.log(`[${sessionId}] ♻️ 5 saniye sonra yeniden bağlanılacak...`);
                setTimeout(() => createSession(sessionId), 5000);
            }
        });

    } catch (err) {
        console.error(`[${sessionId}] ❌ Bağlantı başlatılamadı:`, err.message);
        if (sessions.has(sessionId)) {
            sessions.get(sessionId).isRestarting = false;
        }
        setTimeout(() => createSession(sessionId), 10000);
    }
}

// ── Session Kapat ve Sil ────────────────────────────────────────────
async function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    try {
        if (session.sock) {
            await session.sock.logout().catch(() => {});
            session.sock.end();
        }
    } catch (_) {}

    const authDir = path.join(SESSIONS_ROOT, sessionId);
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }

    sessions.delete(sessionId);
    console.log(`[${sessionId}] 🗑️ Session silindi.`);
    return true;
}

// ── Mesaj Gönderme ──────────────────────────────────────────────────
async function sendMessage(sessionId, chatId, text, mediaUrl) {
    const session = sessions.get(sessionId);
    if (!session || !session.isClientReady) {
        throw new Error(`[${sessionId}] WhatsApp client hazır değil.`);
    }

    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`;
    const { sock } = session;

    if (mediaUrl) {
        console.log(`[${sessionId}] [İNDİRİLİYOR] ${mediaUrl}`);
        const response = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const buffer = Buffer.from(response.data);
        const mimeType = response.headers['content-type'] || 'application/octet-stream';
        const fileName = mediaUrl.split('/').pop() || 'dosya';

        let messageContent;
        if (mimeType.startsWith('image/')) {
            messageContent = { image: buffer, caption: text || '', mimetype: mimeType };
        } else if (mimeType.startsWith('video/')) {
            messageContent = { video: buffer, caption: text || '', mimetype: mimeType };
        } else if (mimeType.startsWith('audio/')) {
            messageContent = { audio: buffer, mimetype: mimeType };
        } else {
            messageContent = { document: buffer, mimetype: mimeType, fileName, caption: text || '' };
        }

        await Promise.race([
            sock.sendMessage(jid, messageContent),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Zaman aşımı (60s)')), 60000)),
        ]);
    } else {
        await Promise.race([
            sock.sendMessage(jid, { text: text || '' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Zaman aşımı (60s)')), 60000)),
        ]);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  SESSION YÖNETİM ENDPOINTLERİ
// ═══════════════════════════════════════════════════════════════════

// Yeni session oluştur
app.post('/session/create', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ success: false, error: 'sessionId zorunludur.' });
    }
    if (sessions.has(sessionId)) {
        return res.status(409).json({ success: false, error: `'${sessionId}' session zaten mevcut.` });
    }

    await createSession(sessionId);
    res.json({ success: true, message: `'${sessionId}' session başlatıldı. QR için /session/${sessionId}/status` });
});

// Session sil
app.delete('/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const result = await deleteSession(sessionId);
    if (!result) {
        return res.status(404).json({ success: false, error: `'${sessionId}' session bulunamadı.` });
    }
    res.json({ success: true, message: `'${sessionId}' session silindi.` });
});

// Belirli bir session'ın durumu (QR dahil)
app.get('/session/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ success: false, error: `'${sessionId}' session bulunamadı.` });
    }
    res.json({
        sessionId,
        qr: session.currentQR,
        connected: session.isConnected,
        user: session.connectedUser,
        ready: session.isClientReady,
    });
});

// Tüm aktif session'lar
app.get('/sessions', (req, res) => {
    const list = [];
    sessions.forEach((session, sessionId) => {
        list.push({
            sessionId,
            connected: session.isConnected,
            user: session.connectedUser,
            ready: session.isClientReady,
            hasQR: !!session.currentQR,
        });
    });
    res.json({ success: true, sessions: list });
});

// ═══════════════════════════════════════════════════════════════════
//  MESAJ ENDPOINTLERİ (session bazlı)
// ═══════════════════════════════════════════════════════════════════

// Metin / medya URL ile mesaj gönder
app.post('/send', async (req, res) => {
    try {
        const { sessionId, number, message, mediaUrl } = req.body;

        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId zorunludur.' });
        }

        const session = sessions.get(sessionId);
        if (!session || !session.isClientReady) {
            return res.status(503).json({ success: false, error: `[${sessionId}] WhatsApp client hazır değil.` });
        }

        const chatId = number.replace('@c.us', '');
        await sendMessage(sessionId, chatId, message, mediaUrl);
        console.log(`[${sessionId}] [GÖNDERİLDİ] ${mediaUrl ? 'Medyalı' : 'Metin'} -> ${number}`);

        res.status(200).json({ success: true, message: 'Gönderildi' });
    } catch (error) {
        console.error('[HATA]', error.message);
        res.status(500).json({ success: false, error: error.toString() });
    }
});

// Base64 resim gönder
app.post('/send-media', async (req, res) => {
    try {
        const { sessionId, phone, imageBase64, mimeType, caption } = req.body;

        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId zorunludur.' });
        }

        const session = sessions.get(sessionId);
        if (!session || !session.isClientReady) {
            return res.status(503).json({ success: false, error: `[${sessionId}] WhatsApp client hazır değil.` });
        }

        if (!phone || !imageBase64 || !mimeType) {
            return res.status(400).json({ success: false, error: 'phone, imageBase64 ve mimeType zorunludur.' });
        }

        const chatId = phone.replace('@c.us', '');
        const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`;
        const buffer = Buffer.from(imageBase64, 'base64');

        await Promise.race([
            session.sock.sendMessage(jid, { image: buffer, mimetype: mimeType, caption: caption || '' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Zaman aşımı (60s)')), 60000)),
        ]);

        console.log(`[${sessionId}] [GÖNDERİLDİ] Base64 medya -> ${phone}`);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[HATA]', error.message);
        res.status(500).json({ success: false, error: error.toString() });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GERİYE DÖNÜK UYUMLULUK — Eski tek-session endpoint'leri
//  (Java tarafı güncellenmeden önce çalışmaya devam etsin)
// ═══════════════════════════════════════════════════════════════════
app.get('/status', (req, res) => {
    // "default" session varsa onu döndür, yoksa ilk session'ı döndür
    const session = sessions.get('default') || sessions.values().next().value;
    if (!session) {
        return res.json({ qr: null, connected: false, user: null });
    }
    res.json({ qr: session.currentQR, connected: session.isConnected, user: session.connectedUser });
});

// ── Sağlık Kontrolü ────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        uptime: process.uptime(),
        activeSessions: sessions.size,
        sessions: Array.from(sessions.keys()),
    });
});

// ── Process-seviyesi hata yakalama ──────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('❌ [UNCAUGHT EXCEPTION]', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ [UNHANDLED REJECTION]', reason);
});

// ═══════════════════════════════════════════════════════════════════
//  SUNUCU BAŞLAT + MEVCUT SESSIONLARİ YÜKLE
// ═══════════════════════════════════════════════════════════════════
const server = app.listen(3000, () => {
    console.log('🚀 Node.js WhatsApp Multi-Session Servisi 3000 portunda başlatıldı...');

    // sessions/ klasöründeki mevcut session'ları otomatik yükle
    if (fs.existsSync(SESSIONS_ROOT)) {
        const existingSessions = fs.readdirSync(SESSIONS_ROOT).filter(name => {
            return fs.statSync(path.join(SESSIONS_ROOT, name)).isDirectory();
        });

        if (existingSessions.length > 0) {
            console.log(`📂 ${existingSessions.length} mevcut session bulundu, yükleniyor:`, existingSessions);
            existingSessions.forEach(sessionId => createSession(sessionId));
        } else {
            console.log('📂 Mevcut session bulunamadı. Yeni session oluşturmak için POST /session/create');
        }
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port 3000 zaten kullanımda! Önceki process'i kapatın:\n   lsof -i :3000 -t | xargs kill -9`);
    } else {
        console.error('❌ Sunucu hatası:', err.message);
    }
    process.exit(1);
});