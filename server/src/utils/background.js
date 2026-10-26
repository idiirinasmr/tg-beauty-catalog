/*
 * Фоновые задачи, запущенные без await (уведомления, рассылки, счётчики).
 * На своём сервере они просто выполняются. На Vercel функция «засыпает» сразу после
 * ответа, поэтому src/vercel.js дожидается flush() через waitUntil.
 */

const pending = new Set();

function track(promise) {
    pending.add(promise);
    promise.catch(err => console.error('[background]', err.message)).finally(() => pending.delete(promise));
    return promise;
}

async function flush() {
    while (pending.size) {
        await Promise.allSettled([...pending]);
    }
}

module.exports = { track, flush };
