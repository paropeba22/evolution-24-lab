-- Versioned only. No running database is modified by this candidate task.
ALTER TABLE `NexiIngressScope` ADD COLUMN `secondaryPending` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `NexiIngressJournal` ADD COLUMN `mainMaterializedAt` DATETIME(3), ADD COLUMN `payloadPrunedAt` DATETIME(3),
  ADD COLUMN `legacyControlKind` VARCHAR(32);
CREATE INDEX `NexiIngressJournal_retention_idx`
  ON `NexiIngressJournal` (`instanceId`, `state`, `payloadPrunedAt`, `completedAt`);
CREATE TABLE `NexiIngressEffectLane` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `instanceId` VARCHAR(100) NOT NULL, `kind` VARCHAR(32) NOT NULL,
  `pending` INTEGER NOT NULL DEFAULT 0, `leaseToken` VARCHAR(36), `leaseUntil` DATETIME(3),
  `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `servedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `blockedBy` VARCHAR(36), `blockedReason` VARCHAR(64),
  INDEX `NexiIngressEffectLane_instanceId_nextAttemptAt_servedAt_idx` (`instanceId`, `nextAttemptAt`, `servedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `NexiIngressEffect` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `journalId` VARCHAR(36) NOT NULL, `laneId` VARCHAR(64) NOT NULL,
  `scopeId` VARCHAR(64) NOT NULL, `instanceId` VARCHAR(100) NOT NULL,
  `kind` VARCHAR(32) NOT NULL, `sequence` BIGINT NOT NULL,
  `intent` JSON NOT NULL, `intentDigest` VARCHAR(64) NOT NULL, `intentSignature` VARCHAR(64) NOT NULL,
  `state` VARCHAR(32) NOT NULL DEFAULT 'pending', `result` JSON,
  `attempts` INTEGER NOT NULL DEFAULT 0, `lastError` VARCHAR(64),
  `startedAt` DATETIME(3), `completedAt` DATETIME(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `NexiIngressEffect_journalId_kind_key` (`journalId`, `kind`),
  UNIQUE INDEX `NexiIngressEffect_laneId_sequence_key` (`laneId`, `sequence`),
  INDEX `NexiIngressEffect_instanceId_state_createdAt_idx` (`instanceId`, `state`, `createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
