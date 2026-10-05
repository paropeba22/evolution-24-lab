-- Never relabel an old authority digest as the new canonical contract.
CREATE FUNCTION nexi_attendance_canonical_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."canonicalVersion" IS DISTINCT FROM OLD."canonicalVersion"
 THEN RAISE EXCEPTION 'nexi_attendance_canonical_version_immutable'; END IF;
 RETURN NEW;
END $$;
ALTER TABLE "NexiManagedTransportContext" ADD COLUMN "canonicalVersion" VARCHAR(32) NOT NULL DEFAULT 'legacy_unversioned';
ALTER TABLE "NexiAttendancePreparation" ADD COLUMN "canonicalVersion" VARCHAR(32) NOT NULL DEFAULT 'legacy_unversioned';
ALTER TABLE "NexiReceiptJournal" ADD COLUMN "canonicalVersion" VARCHAR(32) NOT NULL DEFAULT 'legacy_unversioned';
ALTER TABLE "NexiAttendanceEventOutbox" ADD COLUMN "canonicalVersion" VARCHAR(32) NOT NULL DEFAULT 'legacy_unversioned';
CREATE TRIGGER nexi_attendance_canonical BEFORE UPDATE ON "NexiAttendancePreparation"
 FOR EACH ROW EXECUTE FUNCTION nexi_attendance_canonical_version_immutable();
CREATE TRIGGER nexi_attendance_canonical BEFORE UPDATE ON "NexiAttendanceEventOutbox"
 FOR EACH ROW EXECUTE FUNCTION nexi_attendance_canonical_version_immutable();
-- Context/journal updates are already unconditionally prohibited.
ALTER TABLE "NexiManagedTransportContext" ADD CONSTRAINT "NexiManagedTransportContext_canonical"
 CHECK ("canonicalVersion" IN ('legacy_unversioned','canonical_json_v1'));
ALTER TABLE "NexiAttendancePreparation" ADD CONSTRAINT "NexiAttendancePreparation_canonical"
 CHECK ("canonicalVersion" IN ('legacy_unversioned','canonical_json_v1'));
ALTER TABLE "NexiReceiptJournal" ADD CONSTRAINT "NexiReceiptJournal_canonical"
 CHECK ("canonicalVersion" IN ('legacy_unversioned','canonical_json_v1'));
ALTER TABLE "NexiAttendanceEventOutbox" ADD CONSTRAINT "NexiAttendanceEventOutbox_canonical"
 CHECK ("canonicalVersion" IN ('legacy_unversioned','canonical_json_v1'));
