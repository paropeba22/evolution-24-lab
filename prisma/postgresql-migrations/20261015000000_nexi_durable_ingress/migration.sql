-- Candidate only. Apply in a later authorized deployment, before this runtime.
CREATE TABLE "NexiIngressScope" (
  "id" VARCHAR(64) PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "nextSequence" BIGINT NOT NULL DEFAULT 0,
  "pending" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "NexiIngressLane" (
  "id" VARCHAR(64) PRIMARY KEY,
  "scopeId" VARCHAR(64) NOT NULL,
  "instanceId" VARCHAR(100) NOT NULL,
  "sessionIdentity" VARCHAR(64) NOT NULL,
  "pending" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" VARCHAR(36),
  "leaseUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "servedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "NexiIngressLane_instanceId_nextAttemptAt_servedAt_idx"
  ON "NexiIngressLane" ("instanceId", "nextAttemptAt", "servedAt");
CREATE TABLE "NexiIngressJournal" (
  "id" VARCHAR(36) PRIMARY KEY,
  "dedupKey" VARCHAR(64) NOT NULL UNIQUE,
  "scopeId" VARCHAR(64) NOT NULL,
  "laneId" VARCHAR(64) NOT NULL,
  "instanceId" VARCHAR(100) NOT NULL,
  "sessionIdentity" VARCHAR(64) NOT NULL,
  "sequence" BIGINT NOT NULL,
  "envelope" JSONB NOT NULL,
  "payload" TEXT NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
  "checkpoint" VARCHAR(32) NOT NULL DEFAULT 'persisted',
  "association" JSONB,
  "acknowledgement" JSONB,
  "controls" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" VARCHAR(64),
  "continuationStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "NexiIngressJournal_laneId_sequence_key" ON "NexiIngressJournal" ("laneId", "sequence");
CREATE INDEX "NexiIngressJournal_scopeId_state_completedAt_idx" ON "NexiIngressJournal" ("scopeId", "state", "completedAt");
