-- Versioned only. No running database is modified by this candidate task.
ALTER TABLE "NexiIngressScope" ADD COLUMN "secondaryPending" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NexiIngressJournal" ADD COLUMN "mainMaterializedAt" TIMESTAMP(3), ADD COLUMN "payloadPrunedAt" TIMESTAMP(3),
  ADD COLUMN "legacyControlKind" VARCHAR(32);
CREATE INDEX "NexiIngressJournal_retention_idx"
  ON "NexiIngressJournal" ("instanceId", "state", "payloadPrunedAt", "completedAt");
CREATE TABLE "NexiIngressEffectLane" (
  "id" VARCHAR(64) PRIMARY KEY,
  "instanceId" VARCHAR(100) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "pending" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" VARCHAR(36), "leaseUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "servedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "blockedBy" VARCHAR(36), "blockedReason" VARCHAR(64)
);
CREATE INDEX "NexiIngressEffectLane_instanceId_nextAttemptAt_servedAt_idx"
  ON "NexiIngressEffectLane" ("instanceId", "nextAttemptAt", "servedAt");
CREATE TABLE "NexiIngressEffect" (
  "id" VARCHAR(36) PRIMARY KEY,
  "journalId" VARCHAR(36) NOT NULL, "laneId" VARCHAR(64) NOT NULL,
  "scopeId" VARCHAR(64) NOT NULL, "instanceId" VARCHAR(100) NOT NULL,
  "kind" VARCHAR(32) NOT NULL, "sequence" BIGINT NOT NULL,
  "intent" JSONB NOT NULL, "intentDigest" VARCHAR(64) NOT NULL, "intentSignature" VARCHAR(64) NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'pending', "result" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" VARCHAR(64),
  "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "NexiIngressEffect_journalId_kind_key" ON "NexiIngressEffect" ("journalId", "kind");
CREATE UNIQUE INDEX "NexiIngressEffect_laneId_sequence_key" ON "NexiIngressEffect" ("laneId", "sequence");
CREATE INDEX "NexiIngressEffect_instanceId_state_createdAt_idx" ON "NexiIngressEffect" ("instanceId", "state", "createdAt");
