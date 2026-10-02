CREATE TABLE `NexiGroupControl` (
  `instanceId` VARCHAR(100) NOT NULL PRIMARY KEY,
  `accountId` VARCHAR(32) NOT NULL, `managedChannelId` VARCHAR(32) NOT NULL,
  `generation` INTEGER NOT NULL, `revision` INTEGER NOT NULL DEFAULT 0,
  `sessionIdentity` VARCHAR(64) NOT NULL, `nonce` VARCHAR(64) NOT NULL,
  `state` VARCHAR(16) NOT NULL, `rooms` JSON NOT NULL,
  `catalog` JSON, `catalogAt` DATETIME(3), `catalogStale` BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT `NexiGroupControl_instance_fkey` FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `NexiGroupEventOutbox` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `instanceId` VARCHAR(100) NOT NULL,
  `eventId` VARCHAR(36) NOT NULL, `sourceKey` VARCHAR(64) NOT NULL,
  `fingerprint` VARCHAR(64) NOT NULL, `payload` JSON NOT NULL,
  `state` VARCHAR(16) NOT NULL, `attempts` INTEGER NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NOT NULL, `leaseUntil` DATETIME(3), `leaseToken` VARCHAR(36),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `NexiGroupEventOutbox_eventId_key` (`eventId`),
  UNIQUE INDEX `NexiGroupEventOutbox_instanceId_sourceKey_key` (`instanceId`, `sourceKey`),
  INDEX `NexiGroupEventOutbox_instanceId_state_id_idx` (`instanceId`, `state`, `id`),
  CONSTRAINT `NexiGroupEventOutbox_instance_fkey` FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
