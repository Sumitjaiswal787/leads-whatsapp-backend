import axios from 'axios';
import mysql from 'mysql2/promise';

/**
 * Meta Lead Ads Handler for Multi-tenant CRM
 */
const metaHandler = {
    db: null,

    async init() {
        if (!this.db) {
            this.db = await mysql.createPool({
                host: process.env.MYSQLHOST || 'localhost',
                user: process.env.MYSQLUSER || 'root',
                password: process.env.MYSQLPASSWORD || '',
                database: process.env.MYSQLDATABASE || 'whatsapp_crm',
                port: process.env.MYSQLPORT || 3306,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0
            });
        }
    },

    /**
     * GET /webhooks/meta - Verification for Meta Webhooks
     */
    verifyWebhook(req, res) {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        // Use a persistent verify token or a configurable one
        const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'whatsapp_crm_meta_v1';

        if (mode && token) {
            if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                console.log('[Meta] Webhook Verified');
                res.status(200).send(challenge);
            } else {
                res.sendStatus(403);
            }
        }
    },

    /**
     * POST /webhooks/meta - Handle Lead Events
     */
    async handleWebhook(req, res) {
        const body = req.body;

        if (body.object === 'page') {
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    if (change.field === 'leadgen') {
                        const leadgen = change.value;
                        const pageId = entry.id;
                        const leadId = leadgen.leadgen_id;

                        console.log(`[Meta] New Lead Alert! Page: ${pageId}, LeadID: ${leadId}`);
                        
                        try {
                            await this.processLead(pageId, leadId);
                        } catch (err) {
                            console.error('[Meta] Error processing lead:', err.message);
                        }
                    }
                }
            }
            res.status(200).send('EVENT_RECEIVED');
        } else {
            res.sendStatus(404);
        }
    },

    /**
     * Fetch lead data using Tenant's specific token
     */
    async processLead(pageId, leadId) {
        await this.init();

        // 1. Find the Tenant (Admin) associated with this Page ID
        const [rows] = await this.db.execute(
            'SELECT id, fb_access_token FROM users WHERE fb_page_id = ? AND role = "admin" LIMIT 1',
            [pageId]
        );

        if (rows.length === 0) {
            throw new Error(`No tenant found for FB Page ID: ${pageId}`);
        }

        const tenant = rows[0];
        const tenantId = tenant.id;
        const accessToken = tenant.fb_access_token;

        if (!accessToken) {
            throw new Error(`No access token found for tenant: ${tenantId}`);
        }

        // 2. Fetch Lead details from Meta Graph API
        const graphUrl = `https://graph.facebook.com/v21.0/${leadId}?access_token=${accessToken}`;
        const response = await axios.get(graphUrl);
        const fbLeadData = response.data;

        // Map FB fields (email, full_name, phone_number, etc.)
        const fieldData = {};
        if (fbLeadData.field_data) {
            fbLeadData.field_data.forEach(field => {
                fieldData[field.name] = field.values[0];
            });
        }

        // 3. Prepare payload for PHP Backend
        const payload = {
            secret: process.env.WORKER_API_SECRET || 'whatsapp_crm_secret_2026',
            source: 'meta',
            tenant_id: tenantId,
            lead_id: leadId,
            name: fieldData.full_name || fieldData.name || 'Meta Lead',
            from: fieldData.phone_number || '0000000000',
            message: `New Meta Lead from Form: ${fbLeadData.form_id || 'Unknown'}`,
            project_name: fbLeadData.ad_name || fbLeadData.adgroup_name || 'Meta Ad Campaign'
        };

        // 4. Forward to PHP Backend
        const callbackUrl = process.env.PHP_CALLBACK_URL || 'https://whatsapp.tezikaro.com';
        console.log(`[Meta] Forwarding lead ${leadId} to tenant ${tenantId} at ${callbackUrl}`);
        
        await axios.post(`${callbackUrl}/api/callback.php`, payload);
    }
};

export default metaHandler;
