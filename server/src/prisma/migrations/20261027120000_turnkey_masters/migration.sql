-- AlterTable
ALTER TABLE "masters" ADD COLUMN     "claim_code" TEXT,
ALTER COLUMN "telegram_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "masters_claim_code_key" ON "masters"("claim_code");

