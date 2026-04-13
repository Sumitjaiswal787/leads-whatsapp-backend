import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import sessionManager from './sessionManager.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// Set socket for session manager
sessionManager.setSocket(io);

// API Routes
app.get('/', (req, res) => {
    res.send('WhatsApp CRM Backend is running.');
});

// Create/Connect Session
app.post('/api/sessions/init', async (req, res) => {
    const { tenantId, sessionId, secret } = req.body;
    
    if (secret !== 'whatsapp_crm_secret_2026') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await sessionManager.initSession(tenantId, sessionId);
        res.json({ message: 'Session initialization started' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete Session
app.post('/api/sessions/delete', async (req, res) => {
    const { tenantId, sessionId, secret } = req.body;

    if (secret !== 'whatsapp_crm_secret_2026') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await sessionManager.deleteSession(tenantId, sessionId);
        res.json({ message: 'Session deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Send Message
app.post('/api/messages/send', async (req, res) => {
    const { sessionId, number, message, secret } = req.body;

    if (secret !== 'whatsapp_crm_secret_2026') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const target = req.body.jid || req.body.number;
        await sessionManager.sendMessage(sessionId, target, message);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.io connection
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    socket.on('subscribe', (sessionId) => {
        socket.join(sessionId);
        console.log(`Socket ${socket.id} subscribed to ${sessionId}`);
        
        const qr = sessionManager.qrCodes.get(sessionId);
        if (qr) {
            socket.emit('qr', { sessionId, qr });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
    console.log(`Backend server running on port ${PORT}`);
    
    try {
        const connection = await mysql.createConnection({
            host: process.env.MYSQLHOST || 'localhost',
            user: process.env.MYSQLUSER || 'root',
            password: process.env.MYSQLPASSWORD || '',
            database: process.env.MYSQLDATABASE || 'whatsapp_crm',
            port: process.env.MYSQLPORT || 3306
        });
        
        const [rows] = await connection.execute('SELECT tenant_id, session_id FROM whatsapp_sessions');
        console.log(`Auto-loading ${rows.length} sessions...`);
        for (const session of rows) {
            sessionManager.initSession(session.tenant_id, session.session_id);
        }
        await connection.end();
    } catch (error) {
        console.error('Error auto-loading sessions:', error.message);
    }
});
