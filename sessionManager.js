import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pino from 'pino';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_PATH = path.join(__dirname, '..', 'sessions');

const logger = pino({ level: 'silent' });

class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.qrCodes = new Map();
        this.socket = null;
        this.lidToPhone = new Map(); // Maps LID (e.g. 274160781684973) -> real phone (e.g. 918299126022)
    }

    setSocket(socket) {
        this.socket = socket;
    }

    // Load LID->phone mappings from Baileys session files
    loadLidMappings(sessionDir) {
        try {
            const files = fs.readdirSync(sessionDir);
            let count = 0;
            for (const file of files) {
                if (file.startsWith('lid-mapping-') && file.endsWith('_reverse.json')) {
                    const lid = file.replace('lid-mapping-', '').replace('_reverse.json', '');
                    const phone = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
                    this.lidToPhone.set(lid, phone);
                    count++;
                }
            }
            console.log(`[LID MAP] Loaded ${count} LID->phone mappings from disk.`);
        } catch (e) {
            console.log(`[LID MAP] Could not load mappings: ${e.message}`);
        }
    }

    async initSession(tenantId, sessionId) {
        if (this.sessions.has(sessionId)) {
            const existingSock = this.sessions.get(sessionId);
            try { existingSock.ev.removeAllListeners(); } catch(e) {}
            this.sessions.delete(sessionId);
        }

        const sessionDir = path.join(SESSIONS_PATH, `tenant_${tenantId}_${sessionId}`);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            patchMessageBeforeSending: (message) => {
                const requiresPatch = !!(
                    message.buttonsMessage ||
                    message.templateMessage ||
                    message.listMessage
                );
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadata: {},
                                    deviceListMetadataVersion: 2
                                },
                                ...message
                            }
                        }
                    };
                }
                return message;
            }
        });

        this.sessions.set(sessionId, sock);

        sock.ev.on('creds.update', saveCreds);

        // Build LID -> real phone number map from contact list
        sock.ev.on('contacts.upsert', (contacts) => {
            console.log(`[CONTACTS] contacts.upsert fired with ${contacts.length} contacts`);
            for (const contact of contacts) {
                // Log first few contacts to understand structure
                if (contacts.indexOf(contact) < 3) {
                    console.log(`[CONTACT STRUCTURE] keys=${Object.keys(contact).join(',')}, id=${contact.id}, lid=${contact.lid}`);
                }
                // Map by lid field
                if (contact.lid && contact.id) {
                    const lid = contact.lid.split('@')[0].split(':')[0];
                    const phone = contact.id.split('@')[0].split(':')[0];
                    this.lidToPhone.set(lid, phone);
                    console.log(`[LID MAP] ${lid} -> ${phone} (name=${contact.name||contact.notify||'?'})`);
                }
                // Also map if id itself is a lid JID
                if (contact.id && contact.id.includes('@lid') && contact.phone) {
                    const lid = contact.id.split('@')[0].split(':')[0];
                    this.lidToPhone.set(lid, contact.phone);
                    console.log(`[LID MAP v2] ${lid} -> ${contact.phone}`);
                }
            }
            console.log(`[LID MAP SIZE] Total mappings: ${this.lidToPhone.size}`);
        });

        // Also listen for contacts.update
        sock.ev.on('contacts.update', (updates) => {
            for (const update of updates) {
                if (update.lid && update.id) {
                    const lid = update.lid.split('@')[0].split(':')[0];
                    const phone = update.id.split('@')[0].split(':')[0];
                    this.lidToPhone.set(lid, phone);
                    console.log(`[LID MAP UPDATE] ${lid} -> ${phone}`);
                }
            }
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qrCodes.set(sessionId, qr);
                if (this.socket) {
                    this.socket.emit('qr', { sessionId, qr });
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom) ? 
                    lastDisconnect.error.output.statusCode : 0;
                
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`Connection closed for ${sessionId} (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
                
                // Clear state
                this.sessions.delete(sessionId);
                this.qrCodes.delete(sessionId);

                if (shouldReconnect) {
                    setTimeout(() => this.initSession(tenantId, sessionId), 3000);
                } else {
                    // Clear session dir if logged out
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }

                if (this.socket) {
                    this.socket.emit('status', { sessionId, status: shouldReconnect ? 'reconnecting' : 'disconnected' });
                }
            } else if (connection === 'open') {
                console.log(`Session ${sessionId} connected!`);
                this.qrCodes.delete(sessionId);
                // Load LID->phone mappings from Baileys session files on disk
                this.loadLidMappings(sessionDir);
                if (this.socket) {
                    this.socket.emit('status', { sessionId, status: 'connected' });
                }
                // Notify PHP about connection
                this.notifyPHP(tenantId, sessionId, 'connected');
            }
        });

        // Listen for messages
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    const jid = msg.key.remoteJid;
                    const fromMe = msg.key.fromMe;
                    
                    // Skip: own messages, groups, newsletters, broadcast status
                    // CAPTURE: @s.whatsapp.net (real numbers) AND @lid (privacy mode users)
                    const shouldCapture = !fromMe && 
                        !jid.includes('@g.us') && 
                        !jid.includes('@newsletter') && 
                        !jid.includes('status@broadcast');
                    
                    console.log(`[MSG] jid=${jid} | fromMe=${fromMe} | capture=${shouldCapture}`);
                    
                    if (shouldCapture) {
                        this.handleIncomingMessage(tenantId, sessionId, msg);
                    }
                }
            }
        });
    }

    async handleIncomingMessage(tenantId, sessionId, msg) {
        const jid = msg.key.remoteJid;
        const rawId = jid.split('@')[0].split(':')[0];
        const isLid = jid.includes('@lid');

        // Try to resolve LID to real phone number
        let from = rawId;
        if (isLid && this.lidToPhone.has(rawId)) {
            from = this.lidToPhone.get(rawId);
            console.log(`[LID RESOLVED] ${rawId} -> ${from}`);
        } else if (isLid) {
            console.log(`[LID UNRESOLVED] ${rawId} - no mapping found yet`);
        }

        const text = msg.message?.conversation ||
                     msg.message?.extendedTextMessage?.text ||
                     '[Media/Other]';
        const name = msg.pushName || from;

        console.log(`[LEAD] from=${from} | name=${name} | jid=${jid}`);

        const callbackUrl = process.env.PHP_CALLBACK_URL || 'http://localhost:8080';
        // Send to PHP via webhook
        try {
            const axios = (await import('axios')).default;
            await axios.post(`${callbackUrl}/api/callback.php`, {
                tenant_id: tenantId,
                session_id: sessionId,
                jid: msg.key.remoteJid, // Full JID
                from,
                name,
                message: text,
                secret: 'whatsapp_crm_secret_2026'
            });
        } catch (error) {
            console.error('Error hitting PHP callback:', error.message);
        }

        // Handle auto-reply (Simplified)
        // In real app, we would check DB for auto-reply settings
    }

    async notifyPHP(tenantId, sessionId, status) {
        const callbackUrl = process.env.PHP_CALLBACK_URL || 'http://localhost:8080';
        try {
            const axios = (await import('axios')).default;
            await axios.post(`${callbackUrl}/api/callback.php`, {
                tenant_id: tenantId,
                session_id: sessionId,
                event: 'status_update',
                status,
                secret: 'whatsapp_crm_secret_2026'
            });
        } catch (error) {
            console.error('Error notifying PHP:', error.message);
        }
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    async sendMessage(sessionId, jid, text) {
        const sock = this.sessions.get(sessionId);
        if (!sock) throw new Error('Session not found or not connected');
        
        // Use full JID if available, fallback to constructing it
        const targetJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
        await sock.sendMessage(targetJid, { text });
    }

    async deleteSession(tenantId, sessionId) {
        if (this.sessions.has(sessionId)) {
            const sock = this.sessions.get(sessionId);
            try {
                sock.ev.removeAllListeners();
                sock.end();
            } catch (e) {}
            this.sessions.delete(sessionId);
        }
        this.qrCodes.delete(sessionId);

        const sessionDir = path.join(SESSIONS_PATH, `tenant_${tenantId}_${sessionId}`);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        console.log(`Session ${sessionId} deleted and files removed.`);
    }
}

export default new SessionManager();
