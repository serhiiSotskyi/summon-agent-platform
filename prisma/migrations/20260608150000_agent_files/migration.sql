CREATE TABLE "AgentFile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "role" TEXT NOT NULL DEFAULT 'reference',
    "sourceType" TEXT NOT NULL DEFAULT 'external_url',
    "url" TEXT,
    "originalFileName" TEXT,
    "mimeType" TEXT,
    "contentText" TEXT,
    "sizeBytes" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentFile_workspaceId_idx" ON "AgentFile"("workspaceId");
CREATE INDEX "AgentFile_agentId_idx" ON "AgentFile"("agentId");
CREATE INDEX "AgentFile_agentId_role_idx" ON "AgentFile"("agentId", "role");

ALTER TABLE "AgentFile" ADD CONSTRAINT "AgentFile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentFile" ADD CONSTRAINT "AgentFile_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
