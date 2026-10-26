/**
 * Генерация секретов при первой установке.
 *   node scripts/generate-key.js            — создать файл ключа по ENCRYPTION_KEY_PATH из .env
 *   node scripts/generate-key.js <путь>     — создать файл ключа по указанному пути
 * Также печатает случайную строку для JWT_SECRET.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const target = process.argv[2] || process.env.ENCRYPTION_KEY_PATH;
if (!target) {
    console.error('Укажите путь: node scripts/generate-key.js /etc/beauty-saas/encryption.key');
    process.exit(1);
}

const keyPath = path.resolve(path.join(__dirname, '..'), target);
if (fs.existsSync(keyPath)) {
    console.error(`Файл уже существует: ${keyPath}. Не перезаписываю — иначе сохранённые токены ботов станут нечитаемыми.`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(keyPath), { recursive: true });
fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
console.log(`Ключ шифрования создан: ${keyPath}`);
console.log(`JWT_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
