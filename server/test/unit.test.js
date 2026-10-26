const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { encrypt, decrypt } = require('../src/utils/encrypt');
const { validateInitData, validateLoginWidget } = require('../src/utils/telegram-auth');
const { findAnswer } = require('../src/services/faq-engine');
const { signInitData, signLogin } = require('./helpers');

const KEY = crypto.randomBytes(32).toString('hex');
const BOT_TOKEN = '123456:ABCdefGhIJKlmnoPQRstuVWxyz0123456789';

const now = () => String(Math.floor(Date.now() / 1000));

test('encrypt/decrypt: туда-обратно и защита от подмены', () => {
    const enc = encrypt(BOT_TOKEN, KEY);
    assert.notStrictEqual(enc, encrypt(BOT_TOKEN, KEY), 'уникальный IV');
    assert.strictEqual(decrypt(enc, KEY), BOT_TOKEN);
    const tampered = Buffer.from(enc, 'base64');
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decrypt(tampered.toString('base64'), KEY));
});

test('initData: верная подпись принимается, чужой токен и старая дата — нет', () => {
    const user = JSON.stringify({ id: 42, first_name: 'Аня' });
    const good = signInitData({ user, auth_date: now(), query_id: 'q' }, BOT_TOKEN);
    assert.strictEqual(validateInitData(good, BOT_TOKEN).user.id, 42);
    assert.strictEqual(validateInitData(good, '999:other'), null);
    const old = signInitData({ user, auth_date: String(Math.floor(Date.now() / 1000) - 3 * 86400) }, BOT_TOKEN);
    assert.strictEqual(validateInitData(old, BOT_TOKEN), null);
    assert.strictEqual(validateInitData(good.replace('42', '43'), BOT_TOKEN), null);
});

test('Login Widget: проверка подписи', () => {
    const data = signLogin({ id: 7, first_name: 'Ира', auth_date: now() }, BOT_TOKEN);
    assert.ok(validateLoginWidget(data, BOT_TOKEN));
    assert.ok(!validateLoginWidget({ ...data, id: 8 }, BOT_TOKEN));
    assert.ok(!validateLoginWidget({ ...data, hash: 'zz' }, BOT_TOKEN));
});

test('FAQ: поиск по основам слов', () => {
    const faq = [
        { question: 'цена, стоимость, сколько стоит', answer: 'A' },
        { question: 'адрес, где находитесь', answer: 'B' },
        { question: 'парковка', answer: 'C' }
    ];
    assert.strictEqual(findAnswer(faq, 'Подскажите стоимость маникюра?').answer, 'A');
    assert.strictEqual(findAnswer(faq, 'Где вы находитесь?').answer, 'B');
    assert.strictEqual(findAnswer(faq, 'Есть ли парковки рядом')?.answer, 'C');
    assert.strictEqual(findAnswer(faq, 'Привет'), null);
});

test('заголовки безопасности в vercel.json совпадают с серверными', () => {
    const { SECURITY_HEADERS } = require('../src/security-headers');
    const vercel = require('../../vercel.json');
    const statics = vercel.headers.find(h => h.source.includes('admin'));
    const fromVercel = Object.fromEntries(statics.headers.map(h => [h.key, h.value]));
    assert.deepStrictEqual(fromVercel, SECURITY_HEADERS);
});
