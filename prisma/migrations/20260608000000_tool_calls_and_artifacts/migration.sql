-- CreateEnum
CREATE TYPE "ToolCallStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'SKIPPED');

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "connectorType" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "status" "ToolCallStatus" NOT NULL DEFAULT 'PENDING',
    "request" JSONB,
    "response" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "metadata" JSONB,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentArtifact" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "toolCallId" TEXT,
    "artifactType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "mimeType" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolCall_agentRunId_idx" ON "ToolCall"("agentRunId");

-- CreateIndex
CREATE INDEX "ToolCall_agentRunId_status_idx" ON "ToolCall"("agentRunId", "status");

-- CreateIndex
CREATE INDEX "ToolCall_connectorType_toolName_idx" ON "ToolCall"("connectorType", "toolName");

-- CreateIndex
CREATE INDEX "AgentArtifact_agentRunId_idx" ON "AgentArtifact"("agentRunId");

-- CreateIndex
CREATE INDEX "AgentArtifact_agentRunId_artifactType_idx" ON "AgentArtifact"("agentRunId", "artifactType");

-- CreateIndex
CREATE INDEX "AgentArtifact_toolCallId_idx" ON "AgentArtifact"("toolCallId");

-- AddForeignKey
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentArtifact" ADD CONSTRAINT "AgentArtifact_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentArtifact" ADD CONSTRAINT "AgentArtifact_toolCallId_fkey" FOREIGN KEY ("toolCallId") REFERENCES "ToolCall"("id") ON DELETE SET NULL ON UPDATE CASCADE;
