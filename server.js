const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

// ── Durum Yönetimi ──────────────────────────────────────────────────
let sock = null;
let isClientReady = false;
let isRestarting = false;
const AUTH_DIR = path.join(__dirname, '.baileys_auth');
const logger = pino({ level: 'silent' }); // Baileys loglarını sustur

// ── Bağlantıyı Başlat ──────────────────────────────────────────────
async function startConnection() {
    if (isRestarting) {
        console.log('⏳ Zaten yeniden başlatılıyor...');
        return;
    }
    isRestarting = true;
    isClientReady = false;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            printQRInTerminal: false, // Biz kendimiz basacağız
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
        });

        // ── Kimlik Bilgilerini Kaydet ───────────────────────────
        sock.ev.on('creds.update', saveCreds);

        // ── Bağlantı Durumu ─────────────────────────────────────
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            // QR kodu geldiğinde terminale bas
            if (qr) {
                console.log('\n--- QR KODU — LÜTFEN WHATSAPP İLE TARATIN ---');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                isClientReady = true;
                isRestarting = false;
                console.log('✅ WhatsApp Bot Başarıyla Bağlandı ve Hazır!');
            }

            if (connection === 'close') {
                isClientReady = false;
                isRestarting = false;

                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode
                    : lastDisconnect?.error?.output?.statusCode;

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.warn(`🔌 Bağlantı kapandı (kod: ${statusCode || '?'}).`);

                if (statusCode === DisconnectReason.loggedOut) {
                    // Oturum kapatıldıysa auth bilgilerini sil, baştan QR tarat
                    console.log('🗑️  Oturum kapatıldı — auth temizleniyor...');
                    if (fs.existsSync(AUTH_DIR)) {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    }
                }

                if (shouldReconnect) {
                    console.log('♻️  5 saniye sonra yeniden bağlanılacak...');
                    setTimeout(() => startConnection(), 5000);
                } else {
                    console.log('♻️  15 saniye sonra yeniden bağlanılacak (QR gerekecek)...');
                    setTimeout(() => startConnection(), 15000);
                }
            }
        });

    } catch (err) {
        console.error('❌ Bağlantı başlatılamadı:', err.message);
        isRestarting = false;
        setTimeout(() => startConnection(), 10000);
    }
}

// ── Mesaj Gönderme (Retry ile) ──────────────────────────────────────
async function sendMessage(chatId, text, mediaUrl) {
    if (!sock || !isClientReady) {
        throw new Error('WhatsApp client hazır değil.');
    }

    // Numara formatı: 905xx... → 905xx...@s.whatsapp.net
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`;

    if (mediaUrl) {
        console.log(`[İNDİRİLİYOR] ${mediaUrl}`);
        const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
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
            messageContent = { document: buffer, mimetype: mimeType, fileName: fileName, caption: text || '' };
        }

        await sock.sendMessage(jid, messageContent);
    } else {
        await sock.sendMessage(jid, { text: text || '' });
    }
}

// ── Java'nın İstek Atacağı API Ucu ─────────────────────────────────
app.post('/send', async (req, res) => {
    try {
        if (!isClientReady) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp client henüz hazır değil. Lütfen birkaç saniye sonra tekrar deneyin.',
            });
        }

        const { number, message, mediaUrl } = req.body;
        // @c.us formatını @s.whatsapp.net'e çevir (Java tarafı eski format gönderiyorsa)
        const chatId = number.replace('@c.us', '');

        await sendMessage(chatId, message, mediaUrl);
        console.log(`[GÖNDERİLDİ] ${mediaUrl ? 'Medyalı mesaj' : 'Metin'} -> ${number}`);

        res.status(200).json({ success: true, message: 'Gönderildi' });
    } catch (error) {
        console.error('[HATA OLUŞTU]', error.message);
        res.status(500).json({ success: false, error: error.toString() });
    }
});

// ── Sağlık Kontrolü ────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        ready: isClientReady,
        restarting: isRestarting,
        uptime: process.uptime(),
    });
});

// ── Servisi Başlat ──────────────────────────────────────────────────
app.listen(3000, () => {
    console.log('🚀 Node.js WhatsApp Mikroservisi 3000 portunda başlatıldı...');
    startConnection();
});