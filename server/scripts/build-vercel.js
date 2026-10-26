/**
 * Сборка для Vercel (запускается из корня репозитория: npm run vercel-build).
 *  1. Prisma Client + миграции базы (нужен DIRECT_URL в настройках Vercel)
 *  2. Фронтенды -> public/: /admin, /platform, /app — их раздаёт сам Vercel
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const PUBLIC = path.join(ROOT, 'public');

function run(cmd) {
    console.log(`> ${cmd}`);
    execSync(cmd, { cwd: SERVER, stdio: 'inherit' });
}

run('npx prisma generate');
if (process.env.DIRECT_URL) {
    run('npx prisma migrate deploy');
} else {
    console.warn('DIRECT_URL не задан — миграции пропущены');
}

// Простое рекурсивное копирование: fs.cpSync на Windows падает на путях с кириллицей
function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(src, dst);
        else fs.copyFileSync(src, dst);
    }
}

fs.rmSync(PUBLIC, { recursive: true, force: true });
for (const [from, to] of [['admin', 'admin'], ['platform-admin', 'platform'], ['tg-app', 'app']]) {
    copyDir(path.join(ROOT, from), path.join(PUBLIC, to));
}
console.log('Фронтенды скопированы в public/');
