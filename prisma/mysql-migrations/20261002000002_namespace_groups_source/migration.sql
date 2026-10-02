ALTER TABLE `Instance` ADD COLUMN `nexiGroupsSocketOwner` VARCHAR(36);
ALTER TABLE `NexiGroupEventOutbox` ADD COLUMN `sourceSession` VARCHAR(64),
  ADD COLUMN `sourceGeneration` INTEGER, ADD COLUMN `legacyGeneration` INTEGER;
UPDATE `NexiGroupEventOutbox` SET `sourceSession`=JSON_UNQUOTE(JSON_EXTRACT(payload,'$.data.session_identity')),
  `sourceGeneration`=CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.data.binding_generation')) AS SIGNED)
  WHERE JSON_EXTRACT(payload,'$.data.session_identity') IS NOT NULL AND JSON_EXTRACT(payload,'$.data.binding_generation') IS NOT NULL;
UPDATE `NexiGroupEventOutbox` o SET `legacyGeneration`=COALESCE(
  (SELECT generation FROM `NexiGroupControl` c WHERE c.`instanceId`=o.`instanceId`),2147483647)
  WHERE `sourceSession` IS NULL;
ALTER TABLE `NexiGroupEventOutbox` ADD CONSTRAINT `NexiGroupEventOutbox_namespace_check` CHECK (
  (`sourceSession` IS NOT NULL AND LENGTH(`sourceSession`)=64 AND `sourceGeneration` IS NOT NULL AND `sourceGeneration`>0)
  OR (`sourceSession` IS NULL AND `sourceGeneration` IS NULL AND `legacyGeneration` IS NOT NULL AND `legacyGeneration`>0));
