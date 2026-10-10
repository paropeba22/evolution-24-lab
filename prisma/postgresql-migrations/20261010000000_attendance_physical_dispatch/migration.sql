CREATE OR REPLACE FUNCTION nexi_attendance_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
   NOT COALESCE((g->>'scope'='attendance_release_v1' AND g->'physical_dispatch'='false'::jsonb) OR
     (g->>'scope'='attendance_dispatch_v1' AND g->'physical_dispatch'='true'::jsonb AND
      NEW.authority->'physical_dispatch'='true'::jsonb AND NEW.authority->'isolation_cutover'='true'::jsonb AND
      NEW.authority->>'barrier_state'='active' AND NEW.authority->'writer_protocol_version'='2'::jsonb),FALSE) OR
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
