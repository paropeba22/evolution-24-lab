-- Versioned only; not executed by the corrective task.
ALTER TABLE "NexiIngressEffect" ADD COLUMN "conversationLaneId" VARCHAR(64), ADD COLUMN "contractVersion" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "NexiIngressEffect_causal_idx" ON "NexiIngressEffect" ("conversationLaneId", "kind", "contractVersion", "sequence");
CREATE TABLE "NexiIngressContactCache" (
  "id" VARCHAR(64) PRIMARY KEY, "scopeId" VARCHAR(64) NOT NULL,
  "instanceId" VARCHAR(100) NOT NULL, "sessionIdentity" VARCHAR(64) NOT NULL,
  "pnJid" VARCHAR(64) NOT NULL, "lidJid" VARCHAR(64), "journalId" VARCHAR(36) NOT NULL,
  "sequence" BIGINT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "NexiIngressContactCache_pn_key" ON "NexiIngressContactCache" ("scopeId", "sessionIdentity", "pnJid");
CREATE UNIQUE INDEX "NexiIngressContactCache_lid_key" ON "NexiIngressContactCache" ("scopeId", "sessionIdentity", "lidJid");
CREATE INDEX "NexiIngressContactCache_instanceId_expiresAt_idx" ON "NexiIngressContactCache" ("instanceId", "expiresAt");
