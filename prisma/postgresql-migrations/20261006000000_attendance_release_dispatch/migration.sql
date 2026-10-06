-- Additive authority storage; the source physical-dispatch capability stays FALSE.
ALTER TABLE "NexiAttendancePreparation" ADD COLUMN "grantId" VARCHAR(36);
ALTER TABLE "NexiAttendancePreparation" ADD COLUMN "grantDigest" VARCHAR(64);
ALTER TABLE "NexiAttendancePreparation" ADD COLUMN "releaseDigest" VARCHAR(64);
ALTER TABLE "NexiAttendancePreparation" ADD COLUMN "consumptionId" VARCHAR(36);
ALTER TABLE "NexiAttendancePreparation" ADD COLUMN "consumptionDigest" VARCHAR(64);
ALTER TABLE "NexiAttendancePreparation" ADD COLUMN "releasedAuthority" JSONB;
ALTER TABLE "NexiAttendancePreparation" ADD COLUMN "authorityDeadline" TIMESTAMP(3);
ALTER TABLE "NexiAttendancePreparation" DROP CONSTRAINT "NexiAttendancePreparation_no_dispatch";
ALTER TABLE "NexiAttendancePreparation" DROP CONSTRAINT "NexiAttendancePreparation_unknown";
ALTER TABLE "NexiAttendancePreparation" ADD CONSTRAINT "NexiAttendancePreparation_authority_state" CHECK (state IN ('draft','reserved','prepared','awaiting_admission','dispatch_ready_but_disabled','dispatch_started','transport_returned','outcome_unknown','definitively_not_sent') AND ((state IN ('dispatch_started','transport_returned','outcome_unknown')) = "outcomeUnknown"));
CREATE UNIQUE INDEX "NexiAttendancePreparation_grantId_key" ON "NexiAttendancePreparation" ("grantId");
CREATE UNIQUE INDEX "NexiAttendancePreparation_releaseId_key" ON "NexiAttendancePreparation" ("releaseId");
CREATE UNIQUE INDEX "NexiAttendancePreparation_consumptionId_key" ON "NexiAttendancePreparation" ("consumptionId");
CREATE OR REPLACE FUNCTION nexi_attendance_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."revision" <> OLD."revision"+1 OR ROW(NEW."id",NEW."instanceId",NEW."instanceName",NEW."executionId",NEW."transportUnit",NEW."requestId",NEW."inputDigest",NEW."requests",NEW."authority",NEW."intent",NEW."authorityDigest",NEW."payloadDigest",NEW."recipient",NEW."sessionIdentity",NEW."externalId",NEW."preparationNonce",NEW."preparationRevision",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id",OLD."instanceId",OLD."instanceName",OLD."executionId",OLD."transportUnit",OLD."requestId",OLD."inputDigest",OLD."requests",OLD."authority",OLD."intent",OLD."authorityDigest",OLD."payloadDigest",OLD."recipient",OLD."sessionIdentity",OLD."externalId",OLD."preparationNonce",OLD."preparationRevision",OLD."createdAt")
 THEN RAISE EXCEPTION 'nexi_attendance_preparation_immutable'; END IF;
 IF (OLD."attemptId" IS NOT NULL AND NEW."attemptId" IS DISTINCT FROM OLD."attemptId")
 OR (OLD."reservationId" IS NOT NULL AND NEW."reservationId" IS DISTINCT FROM OLD."reservationId")
 OR (OLD."admissionId" IS NOT NULL AND NEW."admissionId" IS DISTINCT FROM OLD."admissionId")
 OR (OLD."releaseId" IS NOT NULL AND NEW."releaseId" IS DISTINCT FROM OLD."releaseId")
 OR (OLD."dispatchStartedAt" IS NOT NULL AND NEW."dispatchStartedAt" IS DISTINCT FROM OLD."dispatchStartedAt")
 OR (OLD."releaseConsumedAt" IS NOT NULL AND NEW."releaseConsumedAt" IS DISTINCT FROM OLD."releaseConsumedAt")
 OR (OLD."reservedAt" IS NOT NULL AND NEW."reservedAt" IS DISTINCT FROM OLD."reservedAt")
 OR (OLD."closedAt" IS NOT NULL AND NEW."closedAt" IS DISTINCT FROM OLD."closedAt")
 OR (OLD."closureReason" IS NOT NULL AND NEW."closureReason" IS DISTINCT FROM OLD."closureReason")
 OR (OLD."successorId" IS NOT NULL AND NEW."successorId" IS DISTINCT FROM OLD."successorId")
 OR (NEW."successorId" IS NOT NULL AND NOT (NEW.state='definitively_not_sent' AND NEW."closureReason"='collision_fenced'))
 OR (OLD."frozenAt" IS NOT NULL AND ROW(NEW."frozenAt",NEW."contentDigest",NEW."preparationDigest") IS DISTINCT FROM ROW(OLD."frozenAt",OLD."contentDigest",OLD."preparationDigest"))
 THEN RAISE EXCEPTION 'nexi_attendance_preparation_frozen'; END IF;
 IF NEW.state<>OLD.state AND NOT ((OLD.state='draft' AND NEW.state IN ('reserved','definitively_not_sent','outcome_unknown'))
 OR (OLD.state='reserved' AND NEW.state IN ('prepared','outcome_unknown'))
 OR (OLD.state='prepared' AND NEW.state IN ('awaiting_admission','dispatch_ready_but_disabled','outcome_unknown'))
 OR (OLD.state='awaiting_admission' AND NEW.state IN ('dispatch_ready_but_disabled','outcome_unknown'))
 OR (OLD.state='dispatch_ready_but_disabled' AND NEW.state='dispatch_started')
 OR (OLD.state='dispatch_started' AND NEW.state IN ('transport_returned','outcome_unknown')))
 THEN RAISE EXCEPTION 'nexi_attendance_preparation_no_reset'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION nexi_attendance_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g jsonb; r jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'draft' OR NEW."consumptionId" IS NOT NULL OR NEW."grantId" IS NOT NULL OR NEW."releaseId" IS NOT NULL OR NEW."admissionId" IS NOT NULL OR NEW."dispatchStartedAt" IS NOT NULL OR NEW."releaseConsumedAt" IS NOT NULL OR NEW."transportReturn" IS NOT NULL OR NEW."outcomeUnknown" OR NEW.revision<>0
  THEN RAISE EXCEPTION 'nexi_attendance_authority_initial'; END IF;
 ELSE
  IF OLD."consumptionId" IS NOT NULL AND ROW(NEW."consumptionId",NEW."consumptionDigest",NEW."grantId",NEW."grantDigest",NEW."releaseDigest",NEW."releasedAuthority",NEW."authorityDeadline") IS DISTINCT FROM ROW(OLD."consumptionId",OLD."consumptionDigest",OLD."grantId",OLD."grantDigest",OLD."releaseDigest",OLD."releasedAuthority",OLD."authorityDeadline")
  OR (OLD."transportReturn" IS NOT NULL AND NEW."transportReturn" IS DISTINCT FROM OLD."transportReturn") OR (OLD."outcomeUnknown" AND NOT NEW."outcomeUnknown")
  THEN RAISE EXCEPTION 'nexi_attendance_consumption_write_once'; END IF;
  IF OLD."consumptionId" IS NULL AND NEW."consumptionId" IS NOT NULL AND NOT (OLD.state IN ('prepared','awaiting_admission') AND NEW.state='dispatch_ready_but_disabled')
  THEN RAISE EXCEPTION 'nexi_attendance_consumption_order'; END IF;
  IF OLD."dispatchStartedAt" IS NULL AND NEW."dispatchStartedAt" IS NOT NULL AND NOT (OLD.state='dispatch_ready_but_disabled' AND NEW.state='dispatch_started' AND OLD."releaseConsumedAt" IS NOT NULL AND OLD."consumptionId" IS NOT NULL)
  THEN RAISE EXCEPTION 'nexi_attendance_dispatch_order'; END IF;
 END IF;
 IF NEW."consumptionId" IS NOT NULL THEN
  g=NEW."releasedAuthority"->'grant'; r=NEW."releasedAuthority"->'release';
  IF NEW."canonicalVersion"<>'canonical_json_v1' OR NEW."grantId" IS NULL OR NEW."admissionId" IS NULL OR NEW."releaseId" IS NULL OR NEW."consumptionDigest" IS NULL OR NEW."grantDigest" IS NULL OR NEW."releaseDigest" IS NULL OR NEW."releasedAuthority" IS NULL OR NEW."authorityDeadline" IS NULL OR NEW."releaseConsumedAt" IS NULL OR NEW."frozenAt" IS NULL OR NEW."attemptId" IS NULL OR NEW."reservationId" IS NULL OR NEW."contentDigest" IS NULL OR NEW."preparationDigest" IS NULL OR
   g->>'scope' IS DISTINCT FROM 'attendance_release_v1' OR g->'physical_dispatch' IS DISTINCT FROM 'false'::jsonb OR
   NEW."releasedAuthority"->>'consumption_id' IS DISTINCT FROM NEW."consumptionId" OR
   NEW."releasedAuthority"->>'grant_digest' IS DISTINCT FROM NEW."grantDigest" OR NEW."releasedAuthority"->>'release_digest' IS DISTINCT FROM NEW."releaseDigest" OR
   g->>'grant_id' IS DISTINCT FROM NEW."grantId" OR g->>'admission_id' IS DISTINCT FROM NEW."admissionId" OR
   g->>'execution_id' IS DISTINCT FROM NEW."executionId" OR g->>'attempt_id' IS DISTINCT FROM NEW."attemptId" OR
   g->>'transport_unit_index' IS DISTINCT FROM NEW."transportUnit"::text OR g->>'reservation_id' IS DISTINCT FROM NEW."reservationId" OR
   g->>'external_id' IS DISTINCT FROM NEW."externalId" OR g->>'preparation_id' IS DISTINCT FROM NEW.id OR
   g->>'preparation_digest' IS DISTINCT FROM NEW."preparationDigest" OR g->>'prepared_content_digest' IS DISTINCT FROM NEW."contentDigest" OR
   g->>'authority_snapshot_digest' IS DISTINCT FROM NEW."authorityDigest" OR g->>'session_identity' IS DISTINCT FROM NEW."sessionIdentity" OR
   g->'account_id' IS DISTINCT FROM NEW.authority->'account_id' OR g->'managed_channel_id' IS DISTINCT FROM NEW.authority->'managed_channel_id' OR
   g->'instance_lineage_id' IS DISTINCT FROM NEW.authority->'instance_lineage_id' OR g->'sender_account_lineage_id' IS DISTINCT FROM NEW.authority->'sender_account_lineage_id' OR
   g->'writer_epoch' IS DISTINCT FROM NEW.authority->'writer_epoch' OR g->'binding_generation' IS DISTINCT FROM NEW.authority->'binding_generation' OR
   g->'identity_version_id' IS DISTINCT FROM NEW.intent->'identity_version_id' OR
   r->>'release_id' IS DISTINCT FROM NEW."releaseId" OR r->>'grant_id' IS DISTINCT FROM NEW."grantId" OR r->>'grant_digest' IS DISTINCT FROM NEW."grantDigest" OR
   r->>'attempt_id' IS DISTINCT FROM NEW."attemptId" OR r->>'reservation_id' IS DISTINCT FROM NEW."reservationId" OR r->>'external_id' IS DISTINCT FROM NEW."externalId" OR
   r->>'preparation_id' IS DISTINCT FROM NEW.id OR r->>'preparation_digest' IS DISTINCT FROM NEW."preparationDigest" OR
   r->>'decision' IS DISTINCT FROM 'released' OR r->>'grant_state' IS DISTINCT FROM 'release_committed' OR
   (r->>'deadline')::bigint IS DISTINCT FROM floor(extract(epoch FROM NEW."authorityDeadline")*1000)::bigint OR
   (g->>'expires_at')::bigint<(r->>'deadline')::bigint OR
   NEW."releaseConsumedAt">=NEW."authorityDeadline" OR NEW.state NOT IN ('dispatch_ready_but_disabled','dispatch_started','transport_returned','outcome_unknown')
  THEN RAISE EXCEPTION 'nexi_attendance_released_authority_required'; END IF;
 ELSE
  IF NEW."grantId" IS NOT NULL OR NEW."grantDigest" IS NOT NULL OR NEW."releaseDigest" IS NOT NULL OR NEW."consumptionDigest" IS NOT NULL OR NEW."releasedAuthority" IS NOT NULL OR NEW."authorityDeadline" IS NOT NULL OR NEW."admissionId" IS NOT NULL OR NEW."releaseId" IS NOT NULL OR NEW."releaseConsumedAt" IS NOT NULL OR NEW."dispatchStartedAt" IS NOT NULL OR NEW."transportReturn" IS NOT NULL OR NEW.state IN ('dispatch_ready_but_disabled','dispatch_started','transport_returned')
  THEN RAISE EXCEPTION 'nexi_attendance_unconsumed'; END IF;
 END IF;
 IF NEW."dispatchStartedAt" IS NOT NULL AND (NOT NEW."outcomeUnknown" OR NEW."dispatchStartedAt">=NEW."authorityDeadline" OR NEW.state NOT IN ('dispatch_started','transport_returned','outcome_unknown'))
 OR (NEW."transportReturn" IS NOT NULL AND NEW."dispatchStartedAt" IS NULL)
 OR (NEW.state IN ('dispatch_started','transport_returned') AND NEW."dispatchStartedAt" IS NULL)
 THEN RAISE EXCEPTION 'nexi_attendance_dispatch_unknown_required'; END IF;
 IF TG_OP='UPDATE' AND ((OLD."consumptionId" IS NULL AND NEW."consumptionId" IS NOT NULL) OR (OLD."dispatchStartedAt" IS NULL AND NEW."dispatchStartedAt" IS NOT NULL)) AND NEW."authorityDeadline"<=clock_timestamp()
 THEN RAISE EXCEPTION 'nexi_attendance_authority_expired'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER nexi_attendance_authority BEFORE INSERT OR UPDATE ON "NexiAttendancePreparation" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_authority_guard();
