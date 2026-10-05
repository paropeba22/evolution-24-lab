-- Additive metadata only. Old digests/UUIDs/bodies remain untouched.
ALTER TABLE `NexiManagedTransportContext` ADD COLUMN `canonicalVersion` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'legacy_unversioned';
ALTER TABLE `NexiAttendancePreparation` ADD COLUMN `canonicalVersion` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'legacy_unversioned';
ALTER TABLE `NexiReceiptJournal` ADD COLUMN `canonicalVersion` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'legacy_unversioned';
ALTER TABLE `NexiAttendanceEventOutbox` ADD COLUMN `canonicalVersion` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'legacy_unversioned';
CREATE TRIGGER NexiAttendancePreparation_canonical BEFORE UPDATE ON NexiAttendancePreparation FOR EACH ROW
BEGIN
 IF NOT (NEW.canonicalVersion <=> OLD.canonicalVersion)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_canonical_version_immutable'; END IF;
END;
CREATE TRIGGER NexiAttendanceEventOutbox_canonical BEFORE UPDATE ON NexiAttendanceEventOutbox FOR EACH ROW
BEGIN
 IF NOT (NEW.canonicalVersion <=> OLD.canonicalVersion)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nexi_attendance_canonical_version_immutable'; END IF;
END;
ALTER TABLE `NexiManagedTransportContext` ADD CONSTRAINT `NexiManagedTransportContext_canonical`
 CHECK (`canonicalVersion` IN ('legacy_unversioned','canonical_json_v1'));
ALTER TABLE `NexiAttendancePreparation` ADD CONSTRAINT `NexiAttendancePreparation_canonical`
 CHECK (`canonicalVersion` IN ('legacy_unversioned','canonical_json_v1'));
ALTER TABLE `NexiReceiptJournal` ADD CONSTRAINT `NexiReceiptJournal_canonical`
 CHECK (`canonicalVersion` IN ('legacy_unversioned','canonical_json_v1'));
ALTER TABLE `NexiAttendanceEventOutbox` ADD CONSTRAINT `NexiAttendanceEventOutbox_canonical`
 CHECK (`canonicalVersion` IN ('legacy_unversioned','canonical_json_v1'));
