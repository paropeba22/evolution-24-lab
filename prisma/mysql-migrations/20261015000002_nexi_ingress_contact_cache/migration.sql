-- Versioned only; not executed by the corrective task.
ALTER TABLE `NexiIngressEffect` ADD COLUMN `conversationLaneId` VARCHAR(64), ADD COLUMN `contractVersion` INTEGER NOT NULL DEFAULT 1;
CREATE INDEX `NexiIngressEffect_causal_idx` ON `NexiIngressEffect` (`conversationLaneId`, `kind`, `contractVersion`, `sequence`);
CREATE TABLE `NexiIngressContactCache` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY, `scopeId` VARCHAR(64) NOT NULL,
  `instanceId` VARCHAR(100) NOT NULL, `sessionIdentity` VARCHAR(64) NOT NULL,
  `pnJid` VARCHAR(64) NOT NULL, `lidJid` VARCHAR(64), `journalId` VARCHAR(36) NOT NULL,
  `sequence` BIGINT NOT NULL, `expiresAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `NexiIngressContactCache_pn_key` (`scopeId`, `sessionIdentity`, `pnJid`),
  UNIQUE INDEX `NexiIngressContactCache_lid_key` (`scopeId`, `sessionIdentity`, `lidJid`),
  INDEX `NexiIngressContactCache_instanceId_expiresAt_idx` (`instanceId`, `expiresAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
