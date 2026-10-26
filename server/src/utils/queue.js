/*
 * Очередь исходящих сообщений в памяти процесса (решение совета от 26.10.2026
 * вместо BullMQ + Redis на старте). Интерфейс enqueue() позволит заменить
 * реализацию на BullMQ без правок в вызывающем коде.
 *
 * - Отдельная очередь на каждого бота, не больше RATE_PER_SEC сообщений в секунду
 * - Приоритеты: critical (уведомления мастеру) > high (напоминания) > low (рассылки)
 * - Повтор при 429 делает плагин @grammyjs/auto-retry в bot-manager.js
 * - Рассылки переживают рестарт: статус каждого получателя хранится в БД (broadcast.js)
 */

const RATE_PER_SEC = 20;
const PRIORITIES = ['critical', 'high', 'low'];

const queues = new Map(); // botKey -> { lanes: {critical: [], high: [], low: []}, running }

function getQueue(botKey) {
    if (!queues.has(botKey)) {
        queues.set(botKey, { lanes: { critical: [], high: [], low: [] }, running: false });
    }
    return queues.get(botKey);
}

function nextJob(queue) {
    for (const p of PRIORITIES) {
        if (queue.lanes[p].length) return queue.lanes[p].shift();
    }
    return null;
}

async function drain(botKey) {
    const queue = getQueue(botKey);
    if (queue.running) return;
    queue.running = true;
    try {
        let job;
        while ((job = nextJob(queue))) {
            try {
                job.resolve(await job.fn());
            } catch (err) {
                job.reject(err);
            }
            await new Promise(r => setTimeout(r, 1000 / RATE_PER_SEC));
        }
    } finally {
        queue.running = false;
    }
}

/**
 * Поставить отправку в очередь бота.
 * @param {string} botKey   — id мастера (или 'admin')
 * @param {() => Promise}   fn — функция отправки
 * @param {'critical'|'high'|'low'} priority
 * @returns {Promise} результат fn
 */
function enqueue(botKey, fn, priority = 'high') {
    return new Promise((resolve, reject) => {
        getQueue(botKey).lanes[priority].push({ fn, resolve, reject });
        drain(botKey);
    });
}

function stats() {
    let pending = 0;
    for (const q of queues.values()) {
        pending += PRIORITIES.reduce((sum, p) => sum + q.lanes[p].length, 0);
    }
    return { bots: queues.size, pending };
}

module.exports = { enqueue, stats };
