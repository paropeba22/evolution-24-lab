-- Secondary physical transport state. No Message/Instance FK; deletion must

-- not free a managed classification, reservation correlation or receipt identity.

CREATE TABLE `NexiManagedTransportContext` (
  `id` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `instanceId` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `instanceName` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `managedChannelId` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `sessionIdentity` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `fingerprint` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `payload` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `NexiAttendancePreparation` (
  `id` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `instanceId` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `instanceName` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `executionId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `attemptId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `transportUnit` INTEGER NOT NULL,
  `requestId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `inputDigest` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `requests` JSON NOT NULL,
  `authority` JSON NOT NULL,
  `intent` JSON NOT NULL,
  `authorityDigest` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `payloadDigest` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `recipient` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `sessionIdentity` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `externalId` VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `reservationId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `preparationNonce` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `preparationRevision` INTEGER NOT NULL,
  `contentDigest` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `preparationDigest` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `admissionId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `releaseId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `releaseConsumedAt` DATETIME(3),
  `dispatchStartedAt` DATETIME(3),
  `transportReturn` JSON,
  `outcomeUnknown` BOOLEAN NOT NULL DEFAULT FALSE,
  `state` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 0,
  `reservedAt` DATETIME(3),
  `frozenAt` DATETIME(3),
  `closedAt` DATETIME(3),
  `closureReason` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `successorId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `recoveryAttempts` INTEGER NOT NULL DEFAULT 0,
  `nextRecoveryAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastRecoveryReason` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  CONSTRAINT `NexiAttendancePreparation_unit` CHECK (`transportUnit` >= 0 AND `preparationRevision` > 0 AND `revision` >= 0),
  CONSTRAINT `NexiAttendancePreparation_no_dispatch` CHECK (`dispatchStartedAt` IS NULL AND `releaseConsumedAt` IS NULL AND `transportReturn` IS NULL AND `state` IN ('draft','reserved','prepared','awaiting_admission','outcome_unknown','definitively_not_sent')),
  CONSTRAINT `NexiAttendancePreparation_unknown` CHECK ((`state` = 'outcome_unknown') = `outcomeUnknown`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `NexiReceiptJournal` (
  `id` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `instanceId` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `sessionIdentity` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `sourceKey` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `fingerprint` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `externalId` VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `normalizedStatus` VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `evidence` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `NexiAttendanceEventOutbox` (
  `id` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `instanceId` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `instanceName` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `sessionIdentity` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `eventType` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `version` INTEGER NOT NULL,
  `sourceKey` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `fingerprint` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `body` JSON NOT NULL,
  `state` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NOT NULL,
  `leaseToken` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `leaseUntil` DATETIME(3),
  `acknowledgedAt` DATETIME(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `NexiAttendanceHealth` (
  `instanceId` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `unhealthy` BOOLEAN NOT NULL DEFAULT TRUE,
  `reason` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 0,
  `firstGapAt` DATETIME(3) NOT NULL,
  `lastGapAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`instanceId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE UNIQUE INDEX `NexiManagedTransportContext_fingerprint_key` ON `NexiManagedTransportContext` (`fingerprint`);

CREATE INDEX `NexiManagedTransportContext_instanceId_createdAt_idx` ON `NexiManagedTransportContext` (`instanceId`, `createdAt`);

CREATE UNIQUE INDEX `NexiAttendancePreparation_instanceId_requestId_key` ON `NexiAttendancePreparation` (`instanceId`, `requestId`);

CREATE UNIQUE INDEX `NexiAttendancePreparation_instanceId_externalId_key` ON `NexiAttendancePreparation` (`instanceId`, `externalId`);

CREATE INDEX `NexiAttendancePreparation_instanceId_state_idx` ON `NexiAttendancePreparation` (`instanceId`, `state`);

CREATE UNIQUE INDEX `NexiReceiptJournal_instanceId_sourceKey_key` ON `NexiReceiptJournal` (`instanceId`, `sourceKey`);

CREATE INDEX `NexiReceiptJournal_instanceId_externalId_idx` ON `NexiReceiptJournal` (`instanceId`, `externalId`);

CREATE UNIQUE INDEX `NexiAttendanceEventOutbox_instanceId_sourceKey_key` ON `NexiAttendanceEventOutbox` (`instanceId`, `sourceKey`);

CREATE INDEX `NexiAttendanceEventOutbox_state_nextAttemptAt_idx` ON `NexiAttendanceEventOutbox` (`state`, `nextAttemptAt`);

CREATE TRIGGER `NexiManagedTransportContext_no_delete` BEFORE DELETE ON `NexiManagedTransportContext` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_permanent';

CREATE TRIGGER `NexiManagedTransportContext_immutable` BEFORE UPDATE ON `NexiManagedTransportContext` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_permanent';

CREATE TRIGGER `NexiAttendancePreparation_no_delete` BEFORE DELETE ON `NexiAttendancePreparation` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_permanent';

CREATE TRIGGER `NexiReceiptJournal_no_delete` BEFORE DELETE ON `NexiReceiptJournal` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_permanent';

CREATE TRIGGER `NexiReceiptJournal_immutable` BEFORE UPDATE ON `NexiReceiptJournal` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_permanent';

CREATE TRIGGER `NexiAttendanceEventOutbox_no_delete` BEFORE DELETE ON `NexiAttendanceEventOutbox` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_permanent';

CREATE TRIGGER `NexiAttendanceHealth_no_delete` BEFORE DELETE ON `NexiAttendanceHealth` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_permanent';

CREATE TRIGGER NexiAttendancePreparation_guard BEFORE UPDATE ON NexiAttendancePreparation FOR EACH ROW
BEGIN
 IF NEW.revision<>OLD.revision+1 OR NOT ((NEW.`id` <=> OLD.`id`) AND (NEW.`instanceId` <=> OLD.`instanceId`) AND (NEW.`instanceName` <=> OLD.`instanceName`) AND (NEW.`executionId` <=> OLD.`executionId`) AND (NEW.`transportUnit` <=> OLD.`transportUnit`) AND (NEW.`requestId` <=> OLD.`requestId`) AND (NEW.`inputDigest` <=> OLD.`inputDigest`) AND (NEW.`requests` <=> OLD.`requests`) AND (NEW.`authority` <=> OLD.`authority`) AND (NEW.`intent` <=> OLD.`intent`) AND (NEW.`authorityDigest` <=> OLD.`authorityDigest`) AND (NEW.`payloadDigest` <=> OLD.`payloadDigest`) AND (NEW.`recipient` <=> OLD.`recipient`) AND (NEW.`sessionIdentity` <=> OLD.`sessionIdentity`) AND (NEW.`externalId` <=> OLD.`externalId`) AND (NEW.`preparationNonce` <=> OLD.`preparationNonce`) AND (NEW.`preparationRevision` <=> OLD.`preparationRevision`) AND (NEW.`createdAt` <=> OLD.`createdAt`))
 OR (OLD.attemptId IS NOT NULL AND NOT (NEW.`attemptId` <=> OLD.`attemptId`))
 OR (OLD.reservationId IS NOT NULL AND NOT (NEW.`reservationId` <=> OLD.`reservationId`))
 OR (OLD.admissionId IS NOT NULL AND NOT (NEW.`admissionId` <=> OLD.`admissionId`))
 OR (OLD.releaseId IS NOT NULL AND NOT (NEW.`releaseId` <=> OLD.`releaseId`))
 OR (OLD.dispatchStartedAt IS NOT NULL AND NOT (NEW.`dispatchStartedAt` <=> OLD.`dispatchStartedAt`))
 OR (OLD.releaseConsumedAt IS NOT NULL AND NOT (NEW.`releaseConsumedAt` <=> OLD.`releaseConsumedAt`))
 OR (OLD.reservedAt IS NOT NULL AND NOT (NEW.`reservedAt` <=> OLD.`reservedAt`))
 OR (OLD.closedAt IS NOT NULL AND NOT (NEW.`closedAt` <=> OLD.`closedAt`))
 OR (OLD.closureReason IS NOT NULL AND NOT (NEW.`closureReason` <=> OLD.`closureReason`))
 OR (OLD.successorId IS NOT NULL AND NOT (NEW.`successorId` <=> OLD.`successorId`))
 OR (NEW.successorId IS NOT NULL AND NOT (NEW.state='definitively_not_sent' AND NEW.closureReason='collision_fenced'))
 OR (OLD.frozenAt IS NOT NULL AND NOT ((NEW.`frozenAt` <=> OLD.`frozenAt`) AND (NEW.`contentDigest` <=> OLD.`contentDigest`) AND (NEW.`preparationDigest` <=> OLD.`preparationDigest`)))
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_preparation_immutable'; END IF;
 IF NEW.state<>OLD.state AND NOT ((OLD.state='draft' AND NEW.state IN ('reserved','definitively_not_sent','outcome_unknown'))
 OR (OLD.state='reserved' AND NEW.state IN ('prepared','outcome_unknown'))
 OR (OLD.state='prepared' AND NEW.state IN ('awaiting_admission','outcome_unknown')))
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_preparation_no_reset'; END IF;
END;

CREATE TRIGGER NexiAttendanceEventOutbox_guard BEFORE UPDATE ON NexiAttendanceEventOutbox FOR EACH ROW
BEGIN
 IF NOT ((NEW.`id` <=> OLD.`id`) AND (NEW.`instanceId` <=> OLD.`instanceId`) AND (NEW.`instanceName` <=> OLD.`instanceName`) AND (NEW.`sessionIdentity` <=> OLD.`sessionIdentity`) AND (NEW.`eventType` <=> OLD.`eventType`) AND (NEW.`version` <=> OLD.`version`) AND (NEW.`sourceKey` <=> OLD.`sourceKey`) AND (NEW.`fingerprint` <=> OLD.`fingerprint`) AND (NEW.`body` <=> OLD.`body`) AND (NEW.`createdAt` <=> OLD.`createdAt`)) OR NEW.attempts<OLD.attempts OR (OLD.state='acknowledged' AND NEW.state<>OLD.state)
 OR (OLD.acknowledgedAt IS NOT NULL AND NOT (NEW.`acknowledgedAt` <=> OLD.`acknowledgedAt`))
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_outbox_immutable'; END IF;
END;

-- MySQL TRUNCATE bypasses row triggers. The runtime DB principal MUST NOT

-- have DROP/ALTER privileges; this is checked before any future dispatch activation.
