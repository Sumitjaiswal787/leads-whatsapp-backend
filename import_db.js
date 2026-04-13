import { createConnection } from 'mysql2/promise';
import fs from 'fs';

async function importDb() {
    try {
        const connection = await createConnection({
            host: 'autorack.proxy.rlwy.net',
            port: 36908,
            user: 'root',
            password: 'ZkvkgZgMCzgPirrOwyoVDqpNZYOTffVj',
            database: 'railway',
            multipleStatements: true
        });

        let sql = fs.readFileSync('../whatsapp_crm_export.sql', 'utf16le');
        if (sql.charCodeAt(0) === 0xFEFF) sql = sql.slice(1);
        console.log('Importing SQL... Please wait.');
        await connection.query(sql);
        console.log('Database import successful!');
        process.exit(0);
    } catch (e) {
        console.error('Error importing:', e);
        process.exit(1);
    }
}

importDb();
