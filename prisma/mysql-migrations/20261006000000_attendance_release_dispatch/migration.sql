-- Additive authority storage; physical dispatch remains disabled in source.
ALTER TABLE NexiAttendancePreparation ADD COLUMN `grantId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
ALTER TABLE NexiAttendancePreparation ADD COLUMN `grantDigest` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
ALTER TABLE NexiAttendancePreparation ADD COLUMN `releaseDigest` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
ALTER TABLE NexiAttendancePreparation ADD COLUMN `consumptionId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
ALTER TABLE NexiAttendancePreparation ADD COLUMN `consumptionDigest` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
ALTER TABLE NexiAttendancePreparation ADD COLUMN `releasedAuthority` JSON;
ALTER TABLE NexiAttendancePreparation ADD COLUMN `authorityDeadline` DATETIME(3);
ALTER TABLE NexiAttendancePreparation DROP CHECK NexiAttendancePreparation_no_dispatch;
ALTER TABLE NexiAttendancePreparation DROP CHECK NexiAttendancePreparation_unknown;
ALTER TABLE NexiAttendancePreparation ADD CONSTRAINT NexiAttendancePreparation_authority_state CHECK (state IN ('draft','reserved','prepared','awaiting_admission','dispatch_ready_but_disabled','dispatch_started','transport_returned','outcome_unknown','definitively_not_sent') AND ((state IN ('dispatch_started','transport_returned','outcome_unknown')) = outcomeUnknown));
CREATE UNIQUE INDEX NexiAttendancePreparation_grantId_key ON NexiAttendancePreparation (`grantId`);
CREATE UNIQUE INDEX NexiAttendancePreparation_releaseId_key ON NexiAttendancePreparation (`releaseId`);
CREATE UNIQUE INDEX NexiAttendancePreparation_consumptionId_key ON NexiAttendancePreparation (`consumptionId`);
DROP TRIGGER NexiAttendancePreparation_guard;
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
 OR (OLD.state='prepared' AND NEW.state IN ('awaiting_admission','dispatch_ready_but_disabled','outcome_unknown'))
 OR (OLD.state='awaiting_admission' AND NEW.state IN ('dispatch_ready_but_disabled','outcome_unknown'))
 OR (OLD.state='dispatch_ready_but_disabled' AND NEW.state='dispatch_started')
 OR (OLD.state='dispatch_started' AND NEW.state IN ('transport_returned','outcome_unknown')))
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_preparation_no_reset'; END IF;
END;
CREATE TRIGGER NexiAttendancePreparation_authority_update BEFORE UPDATE ON NexiAttendancePreparation FOR EACH ROW
BEGIN
 DECLARE g JSON; DECLARE r JSON;
 IF (OLD.consumptionId IS NOT NULL AND (NOT (NEW.`grantId` <=> OLD.`grantId`) OR NOT (NEW.`grantDigest` <=> OLD.`grantDigest`) OR NOT (NEW.`releaseDigest` <=> OLD.`releaseDigest`) OR NOT (NEW.`consumptionId` <=> OLD.`consumptionId`) OR NOT (NEW.`consumptionDigest` <=> OLD.`consumptionDigest`) OR NOT (NEW.`releasedAuthority` <=> OLD.`releasedAuthority`) OR NOT (NEW.`authorityDeadline` <=> OLD.`authorityDeadline`))) OR (OLD.transportReturn IS NOT NULL AND NOT (NEW.transportReturn <=> OLD.transportReturn)) OR (OLD.outcomeUnknown AND NOT NEW.outcomeUnknown)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='nexi_attendance_consumption_write_once'; END IF;
 IF OLD.consumptionId IS NULL AND NEW.consumptionId IS NOT NULL AND NOT (OLD.state IN ('prepared','awaiting_admission') AND NEW.state='dispatch_ready_but_disabled')
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='nexi_attendance_consumption_order'; END IF;
 IF OLD.dispatchStartedAt IS NULL AND NEW.dispatchStartedAt IS NOT NULL AND NOT (OLD.state='dispatch_ready_but_disabled' AND NEW.state='dispatch_started' AND OLD.releaseConsumedAt IS NOT NULL AND OLD.consumptionId IS NOT NULL)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='nexi_attendance_dispatch_order'; END IF;
 IF NEW.consumptionId IS NOT NULL THEN
  SET g=JSON_EXTRACT(NEW.releasedAuthority,'$.grant'); SET r=JSON_EXTRACT(NEW.releasedAuthority,'$.release');
  IF NEW.canonicalVersion<>'canonical_json_v1' OR NEW.grantId IS NULL OR NEW.admissionId IS NULL OR NEW.releaseId IS NULL OR NEW.consumptionDigest IS NULL OR NEW.grantDigest IS NULL OR NEW.releaseDigest IS NULL OR NEW.releasedAuthority IS NULL OR NEW.authorityDeadline IS NULL OR NEW.releaseConsumedAt IS NULL OR NEW.frozenAt IS NULL OR NEW.attemptId IS NULL OR NEW.reservationId IS NULL OR NEW.contentDigest IS NULL OR NEW.preparationDigest IS NULL OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.scope')) <=> 'attendance_release_v1') OR NOT (JSON_EXTRACT(g,'$.physical_dispatch') <=> CAST('false' AS JSON)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.grant_id')) <=> CAST(NEW.`grantId` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.admission_id')) <=> CAST(NEW.`admissionId` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.execution_id')) <=> CAST(NEW.`executionId` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.attempt_id')) <=> CAST(NEW.`attemptId` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.transport_unit_index')) <=> CAST(NEW.`transportUnit` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.reservation_id')) <=> CAST(NEW.`reservationId` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.external_id')) <=> CAST(NEW.`externalId` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.preparation_id')) <=> CAST(NEW.`id` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.preparation_digest')) <=> CAST(NEW.`preparationDigest` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.prepared_content_digest')) <=> CAST(NEW.`contentDigest` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.authority_snapshot_digest')) <=> CAST(NEW.`authorityDigest` AS CHAR)) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(g,'$.session_identity')) <=> CAST(NEW.`sessionIdentity` AS CHAR)) OR
   NOT (JSON_EXTRACT(g,'$.account_id') <=> JSON_EXTRACT(NEW.authority,'$.account_id')) OR
   NOT (JSON_EXTRACT(g,'$.managed_channel_id') <=> JSON_EXTRACT(NEW.authority,'$.managed_channel_id')) OR
   NOT (JSON_EXTRACT(g,'$.instance_lineage_id') <=> JSON_EXTRACT(NEW.authority,'$.instance_lineage_id')) OR
   NOT (JSON_EXTRACT(g,'$.sender_account_lineage_id') <=> JSON_EXTRACT(NEW.authority,'$.sender_account_lineage_id')) OR
   NOT (JSON_EXTRACT(g,'$.writer_epoch') <=> JSON_EXTRACT(NEW.authority,'$.writer_epoch')) OR
   NOT (JSON_EXTRACT(g,'$.binding_generation') <=> JSON_EXTRACT(NEW.authority,'$.binding_generation')) OR
   NOT (JSON_EXTRACT(g,'$.identity_version_id') <=> JSON_EXTRACT(NEW.intent,'$.identity_version_id')) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.release_id')) <=> NEW.`releaseId`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.grant_id')) <=> NEW.`grantId`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.grant_digest')) <=> NEW.`grantDigest`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.attempt_id')) <=> NEW.`attemptId`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.reservation_id')) <=> NEW.`reservationId`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.external_id')) <=> NEW.`externalId`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.preparation_id')) <=> NEW.`id`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.preparation_digest')) <=> NEW.`preparationDigest`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(NEW.releasedAuthority,'$.consumption_id')) <=> NEW.`consumptionId`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(NEW.releasedAuthority,'$.grant_digest')) <=> NEW.`grantDigest`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(NEW.releasedAuthority,'$.release_digest')) <=> NEW.`releaseDigest`) OR
   NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.decision')) <=> 'released') OR NOT (JSON_UNQUOTE(JSON_EXTRACT(r,'$.grant_state')) <=> 'release_committed') OR
   NOT (CAST(JSON_UNQUOTE(JSON_EXTRACT(r,'$.deadline')) AS SIGNED) <=> FLOOR(UNIX_TIMESTAMP(NEW.authorityDeadline)*1000)) OR
   CAST(JSON_UNQUOTE(JSON_EXTRACT(g,'$.expires_at')) AS SIGNED)<CAST(JSON_UNQUOTE(JSON_EXTRACT(r,'$.deadline')) AS SIGNED) OR
   NEW.releaseConsumedAt>=NEW.authorityDeadline OR NEW.state NOT IN ('dispatch_ready_but_disabled','dispatch_started','transport_returned','outcome_unknown')
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='nexi_attendance_released_authority_required'; END IF;
 ELSE
  IF NEW.grantId IS NOT NULL OR NEW.grantDigest IS NOT NULL OR NEW.releaseDigest IS NOT NULL OR NEW.consumptionDigest IS NOT NULL OR NEW.releasedAuthority IS NOT NULL OR NEW.authorityDeadline IS NOT NULL OR NEW.admissionId IS NOT NULL OR NEW.releaseId IS NOT NULL OR NEW.releaseConsumedAt IS NOT NULL OR NEW.dispatchStartedAt IS NOT NULL OR NEW.transportReturn IS NOT NULL OR NEW.state IN ('dispatch_ready_but_disabled','dispatch_started','transport_returned')
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='nexi_attendance_unconsumed'; END IF;
 END IF;
 IF (NEW.dispatchStartedAt IS NOT NULL AND (NOT NEW.outcomeUnknown OR NEW.dispatchStartedAt>=NEW.authorityDeadline OR NEW.state NOT IN ('dispatch_started','transport_returned','outcome_unknown'))) OR (NEW.transportReturn IS NOT NULL AND NEW.dispatchStartedAt IS NULL) OR (NEW.state IN ('dispatch_started','transport_returned') AND NEW.dispatchStartedAt IS NULL)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='nexi_attendance_dispatch_unknown_required'; END IF;
 IF ((OLD.consumptionId IS NULL AND NEW.consumptionId IS NOT NULL) OR (OLD.dispatchStartedAt IS NULL AND NEW.dispatchStartedAt IS NOT NULL)) AND NEW.authorityDeadline<=CURRENT_TIMESTAMP(3)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='nexi_attendance_authority_expired'; END IF;
END;
CREATE TRIGGER NexiAttendancePreparation_authority_insert BEFORE INSERT ON NexiAttendancePreparation FOR EACH ROW
BEGIN
 IF NEW.state<>'draft' OR NEW.consumptionId IS NOT NULL OR NEW.grantId IS NOT NULL OR NEW.releaseId IS NOT NULL OR NEW.admissionId IS NOT NULL OR NEW.dispatchStartedAt IS NOT NULL OR NEW.releaseConsumedAt IS NOT NULL OR NEW.transportReturn IS NOT NULL OR NEW.outcomeUnknown OR NEW.revision<>0 OR NEW.grantDigest IS NOT NULL OR NEW.releaseDigest IS NOT NULL OR NEW.consumptionDigest IS NOT NULL OR NEW.releasedAuthority IS NOT NULL OR NEW.authorityDeadline IS NOT NULL
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='nexi_attendance_authority_initial'; END IF;
END;
