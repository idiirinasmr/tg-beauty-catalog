/* Единый экземпляр Prisma Client + сериализация BigInt в JSON */

const { PrismaClient } = require('@prisma/client');

// BigInt (telegram_id) не сериализуется в JSON по умолчанию
BigInt.prototype.toJSON = function () { return this.toString(); };

const prisma = new PrismaClient();

module.exports = prisma;
