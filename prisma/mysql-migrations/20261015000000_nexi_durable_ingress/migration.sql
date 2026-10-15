-- Candidate only. Apply in a later authorized deployment, before this runtime.
CREATE TABLE `NexiIngressScope` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `revision` INTEGER NOT NULL DEFAULT 0,
  `nextSequence` BIGINT NOT NULL DEFAULT 0,
  `pending` INTEGER NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `NexiIngressLane` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `scopeId` VARCHAR(64) NOT NULL,
  `instanceId` VARCHAR(100) NOT NULL,
  `sessionIdentity` VARCHAR(64) NOT NULL,
  `pending` INTEGER NOT NULL DEFAULT 0,
  `leaseToken` VARCHAR(36),
  `leaseUntil` DATETIME(3),
  `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `servedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `NexiIngressLane_instanceId_nextAttemptAt_servedAt_idx` (`instanceId`, `nextAttemptAt`, `servedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE `NexiIngressJournal` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `dedupKey` VARCHAR(64) NOT NULL UNIQUE,
  `scopeId` VARCHAR(64) NOT NULL,
  `laneId` VARCHAR(64) NOT NULL,
  `instanceId` VARCHAR(100) NOT NULL,
  `sessionIdentity` VARCHAR(64) NOT NULL,
  `sequence` BIGINT NOT NULL,
  `envelope` JSON NOT NULL,
  `payload` LONGTEXT NOT NULL,
  `state` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `checkpoint` VARCHAR(32) NOT NULL DEFAULT 'persisted',
  `association` JSON,
  `acknowledgement` JSON,
  `controls` JSON,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `lastError` VARCHAR(64),
  `continuationStartedAt` DATETIME(3),
  `completedAt` DATETIME(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `NexiIngressJournal_laneId_sequence_key` (`laneId`, `sequence`),
  INDEX `NexiIngressJournal_scopeId_state_completedAt_idx` (`scopeId`, `state`, `completedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
