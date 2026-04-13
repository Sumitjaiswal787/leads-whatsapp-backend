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
        origin: ["https://whatsapp.tezikaro.com", "http://localhost:3000", "http://localhost:8080"],
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["my-custom-header"],
    },
    allowEIO3: true // Support older clients if needed
});

// Use a more permissive CORS for Express as well
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        const allowed = ["https://whatsapp.tezikaro.com", "http://localhost:3000", "http://localhost:8080"];
        if (allowed.indexOf(origin) !== -1 || origin.includes('railway.app')) {
            callback(null, true);
        } else {
            console.log("[CORS] Blocked origin:", origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));
app.use(express.json());

// Set socket for session manager
sessionManager.setSocket(io);

// API Routes
app.get('/', (req, res) => {
    res.send('WhatsApp CRM Backend is running. Time: ' + new Date().toISOString());
});

// Diagnostic endpoint to test connectivity to Hostinger
app.get('/test-callback', async (req, res) => {
    const callbackUrl = process.env.PHP_CALLBACK_URL || 'http://localhost:8080';
    try {
        const axios = (await import('axios')).default;
        console.log(`[Test] Attempting to reach: ${callbackUrl}/api/callback.php`);
        const response = await axios.post(`${callbackUrl}/api/callback.php`, {
            event: 'connectivity_test',
            secret: 'whatsapp_crm_secret_2026',
            timestamp: new Date().toISOString()
        }, { timeout: 10000 });
        
        res.json({
            status: 'connected',
            callbackUrl,
            php_response: response.data,
            message: 'Railway reached Hostinger successfully!'
        });
    } catch (error) {
        console.error(`[Test] Failed to reach ${callbackUrl}:`, error.message);
        res.status(500).json({
            status: 'failed',
            callbackUrl,
            error: error.message,
            hint: 'Check if PHP_CALLBACK_URL is set correctly in Railway and if Hostinger allows incoming requests.'
        });
    }
});

// Create/Connect Session
app.post('/api/sessions/init', async (req, res) => {
    const { tenantId, sessionId, secret } = req.body;
    console.log(`[API] Received init request for tenant: ${tenantId}, session: ${sessionId}`);
    
    if (secret !== 'whatsapp_crm_secret_2026') {
        console.warn(`[API] Unauthorized init attempt for session: ${sessionId}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await sessionManager.initSession(tenantId, sessionId);
        res.json({ message: 'Session initialization started' });
    } catch (error) {
        console.error(`[API] Init failed for ${sessionId}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// Socket.io connection
io.on('connection', (socket) => {
    console.log('[Socket] New client connected:', socket.id);
    
    socket.on('subscribe', (sessionId) => {
        socket.join(sessionId);
        console.log(`[Socket] Client ${socket.id} subscribed to room: ${sessionId}`);
        
        // Immediate state sync
        const qr = sessionManager.qrCodes.get(sessionId);
        if (qr) {
            console.log(`[Socket] Sending cached QR to ${socket.id} for session ${sessionId}`);
            socket.emit('qr', { sessionId, qr });
        }
        
        // Send actual status if available
        const state = sessionManager.sessions.get(sessionId);
        if (state && state.user) {
            socket.emit('status', { sessionId, status: 'connected' });
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`[Socket] Client disconnected: ${socket.id} (${reason})`);
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
    console.log(`[Server] WhatsApp Worker running on port ${PORT}`);
    
    try {
        const dbConfig = {
            host: process.env.MYSQLHOST || 'localhost',
            user: process.env.MYSQLUSER || 'root',
            password: process.env.MYSQLPASSWORD || '',
            database: process.env.MYSQLDATABASE || 'whatsapp_crm',
            port: process.env.MYSQLPORT || 3306,
            connectTimeout: 10000
        };
        
        console.log(`[DB] Attempting to auto-load sessions from ${dbConfig.host}...`);
        const connection = await mysql.createConnection(dbConfig);
        
        const [rows] = await connection.execute('SELECT tenant_id, session_id FROM whatsapp_sessions');
        console.log(`[DB] Found ${rows.length} sessions to initialize.`);
        
        for (const session of rows) {
            sessionManager.initSession(session.tenant_id, session.session_id);
        }
        await connection.end();
    } catch (error) {
        console.error('[DB] Auto-load failed:', error.message);
        console.info('[DB] Note: Railway backend will still accept new session requests via API even if Hostinger DB is initially unreachable.');
    }
});
