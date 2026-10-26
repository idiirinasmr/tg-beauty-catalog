/*
 * Поиск ответа по FAQ мастера. faq.question — ключевые слова/фразы через запятую,
 * например: «цена, стоимость, сколько стоит».
 * Сравнение по основам слов (первые 5 букв), чтобы «маникюра»/«маникюр» совпадали.
 */

const prisma = require('../utils/db');

function normalize(text) {
    return text.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/g, ' ');
}

function stems(text) {
    return normalize(text).split(/\s+/).filter(w => w.length > 1).map(w => w.slice(0, 5));
}

/** Сколько ключевых фраз FAQ встречается в сообщении (фраза совпала, если совпали все её слова) */
function score(messageStems, keywords) {
    const set = new Set(messageStems);
    return keywords.split(',')
        .map(k => stems(k))
        .filter(k => k.length && k.every(s => set.has(s)))
        .length;
}

function findAnswer(faqList, message) {
    const msg = stems(message);
    let best = null;
    let bestScore = 0;
    for (const item of faqList) {
        const s = score(msg, item.question);
        if (s > bestScore) {
            best = item;
            bestScore = s;
        }
    }
    return best;
}

async function answerFor(masterId, message) {
    const faq = await prisma.faq.findMany({ where: { masterId }, orderBy: { sortOrder: 'asc' } });
    return findAnswer(faq, message)?.answer || null;
}

module.exports = { answerFor, findAnswer };
