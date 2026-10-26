/* Подпись initData и Login Widget для тестов (как это делает Telegram) */

const crypto = require('crypto');

function signInitData(fields, botToken) {
    const params = new URLSearchParams(fields);
    const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
    return params.toString();
}

function signLogin(fields, botToken) {
    const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
    const secret = crypto.createHash('sha256').update(botToken).digest();
    return { ...fields, hash: crypto.createHmac('sha256', secret).update(dcs).digest('hex') };
}

module.exports = { signInitData, signLogin };
