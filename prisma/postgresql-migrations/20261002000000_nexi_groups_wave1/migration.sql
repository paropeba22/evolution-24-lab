CREATE TABLE "NexiGroupControl" (
  "instanceId" VARCHAR(100) PRIMARY KEY REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "accountId" VARCHAR(32) NOT NULL, "managedChannelId" VARCHAR(32) NOT NULL,
  "generation" INTEGER NOT NULL CHECK ("generation" > 0), "revision" INTEGER NOT NULL DEFAULT 0,
  "sessionIdentity" VARCHAR(64) NOT NULL, "nonce" VARCHAR(64) NOT NULL,
  "state" VARCHAR(16) NOT NULL, "rooms" JSONB NOT NULL,
  "catalog" JSONB, "catalogAt" TIMESTAMP(3), "catalogStale" BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE "NexiGroupEventOutbox" (
  "id" BIGSERIAL PRIMARY KEY,
  "instanceId" VARCHAR(100) NOT NULL REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "eventId" VARCHAR(36) NOT NULL UNIQUE, "sourceKey" VARCHAR(64) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL, "payload" JSONB NOT NULL,
  "state" VARCHAR(16) NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL, "leaseUntil" TIMESTAMP(3), "leaseToken" VARCHAR(36),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("instanceId", "sourceKey")
);
CREATE INDEX "NexiGroupEventOutbox_instanceId_state_id_idx" ON "NexiGroupEventOutbox"("instanceId", "state", "id");
