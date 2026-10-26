-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "paid_at" TIMESTAMP(3);


-- Уже оплаченные платежи: считаем датой оплаты дату создания
UPDATE "payments" SET "paid_at" = "created_at" WHERE "status" = 'paid';
