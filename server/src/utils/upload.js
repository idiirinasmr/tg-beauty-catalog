/*
 * Загрузка фото. Прод: Supabase Storage (публичный бакет SUPABASE_BUCKET).
 * Локально без SUPABASE_SERVICE_KEY: папка server/uploads, раздаётся по /uploads/.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const MAX_SIZE = 5 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const LOCAL_DIR = path.join(__dirname, '..', '..', 'uploads');

function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

/** Прочитать файл из multipart-запроса Fastify и проверить тип/размер */
async function readImage(request) {
    const file = await request.file({ limits: { fileSize: MAX_SIZE, files: 1 } });
    if (!file) throw httpError(400, 'Файл не передан');
    const ext = TYPES[file.mimetype];
    if (!ext) throw httpError(400, 'Допустимы только JPG, PNG или WEBP');
    const buffer = await file.toBuffer(); // бросит 413 при превышении лимита
    return { buffer, ext, mimetype: file.mimetype, fields: file.fields };
}

/** Сохранить и вернуть публичный URL. folder — например `${masterId}/portfolio` */
async function saveImage({ buffer, ext, mimetype }, folder) {
    const name = `${folder}/${crypto.randomUUID()}.${ext}`;

    if (!config.supabaseServiceKey) {
        // На Vercel диск только для чтения — без Supabase Storage фото не сохранить
        if (config.serverless) throw httpError(503, 'Хранилище фото не настроено (SUPABASE_SERVICE_KEY)');
        const target = path.join(LOCAL_DIR, name);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, buffer);
        return `${config.appUrl}/uploads/${name}`;
    }

    const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${config.supabaseBucket}/${name}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.supabaseServiceKey}`,
            'Content-Type': mimetype,
            'Cache-Control': 'max-age=31536000'
        },
        body: buffer,
        signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw httpError(502, `Не удалось загрузить фото: ${await res.text()}`);
    return `${config.supabaseUrl}/storage/v1/object/public/${config.supabaseBucket}/${name}`;
}

/** Удалить ранее загруженный файл (ошибки игнорируются — файл мог быть удалён вручную) */
async function deleteImage(url) {
    if (!url) return;
    try {
        const localPrefix = `${config.appUrl}/uploads/`;
        const remotePrefix = `${config.supabaseUrl}/storage/v1/object/public/${config.supabaseBucket}/`;
        if (url.startsWith(localPrefix)) {
            const target = path.join(LOCAL_DIR, url.slice(localPrefix.length));
            if (target.startsWith(LOCAL_DIR)) await fs.promises.unlink(target);
        } else if (url.startsWith(remotePrefix) && config.supabaseServiceKey) {
            await fetch(`${config.supabaseUrl}/storage/v1/object/${config.supabaseBucket}/${url.slice(remotePrefix.length)}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${config.supabaseServiceKey}` }
            });
        }
    } catch { /* не критично */ }
}

module.exports = { readImage, saveImage, deleteImage, LOCAL_DIR };
