-- AlterTable
ALTER TABLE "WorkspaceInvitation"
ADD COLUMN "tokenHash" TEXT,
ADD COLUMN "lastSentAt" TIMESTAMP(3),
ADD COLUMN "deliveryStatus" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation"("tokenHash");
