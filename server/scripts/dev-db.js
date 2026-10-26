/**
 * Локальный PostgreSQL для разработки — PGlite (Postgres внутри Node.js,
 * без установки Postgres/Docker и без зависимости от локали Windows).
 * Запуск: node scripts/dev-db.js — держит базу запущенной до Ctrl+C.
 * Строка подключения: postgresql://postgres:postgres@localhost:54329/postgres?connection_limit=1&sslmode=disable
 */

const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

(async () => {
    const db = await PGlite.create(path.join(__dirname, '..', '.dev-db'));
    const server = new PGLiteSocketServer({ db, port: 54329, host: '127.0.0.1', maxConnections: 20 });
    await server.start();
    console.log('PostgreSQL (PGlite) запущен на 127.0.0.1:54329');

    const stop = async () => { await server.stop(); await db.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
})().catch(err => { console.error(err); process.exit(1); });
