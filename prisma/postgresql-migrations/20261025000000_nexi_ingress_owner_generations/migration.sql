-- PREPARED ONLY. PostgreSQL-only receive-generation metadata. No journal,
-- lane, cursor, original timestamp or pending counter is rewritten/backfilled.
CREATE TABLE "NexiIngressOwnerRoot" (
  "id" VARCHAR(64) PRIMARY KEY,
  "scopeId" VARCHAR(64) NOT NULL REFERENCES "NexiIngressScope"("id"),
  "instanceId" VARCHAR(100) NOT NULL,
  "sessionIdentity" VARCHAR(64) NOT NULL,
  "pnJid" VARCHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision">=0),
  "activeGenerationId" VARCHAR(36),
  "sourceFloorSequence" BIGINT CHECK ("sourceFloorSequence">=0)
);
CREATE TABLE "NexiIngressOwnerGeneration" (
  "id" VARCHAR(36) PRIMARY KEY,
  "candidateId" VARCHAR(36) NOT NULL UNIQUE,
  "rootLaneId" VARCHAR(64) NOT NULL REFERENCES "NexiIngressOwnerRoot"("id"),
  "oldLaneId" VARCHAR(64) NOT NULL REFERENCES "NexiIngressLane"("id"),
  "newLaneId" VARCHAR(64) NOT NULL UNIQUE,
  "scopeId" VARCHAR(64) NOT NULL REFERENCES "NexiIngressScope"("id"),
  "instanceId" VARCHAR(100) NOT NULL,
  "sessionIdentity" VARCHAR(64) NOT NULL,
  "rootRevision" INTEGER NOT NULL CHECK ("rootRevision">0),
  "cutoffSequence" BIGINT NOT NULL CHECK ("cutoffSequence">0),
  "cutover" JSONB NOT NULL,
  "cutoverDigest" VARCHAR(64) NOT NULL,
  "witness" JSONB NOT NULL,
  "snapshot" JSONB NOT NULL,
  "frozenLaneId" VARCHAR(64) UNIQUE REFERENCES "NexiIngressLane"("id"),
  "approval" JSONB,
  "installedAt" TIMESTAMP(3),
  "registration" JSONB,
  "registeredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (jsonb_typeof("cutover")='object' AND jsonb_typeof("witness")='object' AND jsonb_typeof("snapshot")='array'),
  CHECK (("approval" IS NULL AND "installedAt" IS NULL AND "frozenLaneId" IS NULL) OR
    ("approval" IS NOT NULL AND "installedAt" IS NOT NULL AND "frozenLaneId"="oldLaneId")),
  CHECK (("registration" IS NULL AND "registeredAt" IS NULL) OR
    ("approval" IS NOT NULL AND "registration" IS NOT NULL AND "registeredAt" IS NOT NULL))
);
ALTER TABLE "NexiIngressOwnerRoot" ADD CONSTRAINT "NexiIngressOwnerRoot_generation_fk"
  FOREIGN KEY ("activeGenerationId") REFERENCES "NexiIngressOwnerGeneration"("id");
CREATE INDEX "NexiIngressOwnerGeneration_instanceId_createdAt_idx" ON "NexiIngressOwnerGeneration" ("instanceId","createdAt");
CREATE INDEX "NexiIngressOwnerGeneration_rootLaneId_rootRevision_idx" ON "NexiIngressOwnerGeneration" ("rootLaneId","rootRevision");

CREATE TABLE "NexiIngressOwnerSource" (
  "id" VARCHAR(36) PRIMARY KEY,
  "dedupKey" VARCHAR(64) NOT NULL UNIQUE,
  "rootLaneId" VARCHAR(64) NOT NULL REFERENCES "NexiIngressOwnerRoot"("id"),
  "scopeId" VARCHAR(64) NOT NULL REFERENCES "NexiIngressScope"("id"),
  "instanceId" VARCHAR(100) NOT NULL,
  "sessionIdentity" VARCHAR(64) NOT NULL,
  "sequence" BIGINT NOT NULL,
  "envelope" JSONB NOT NULL,
  "payload" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("rootLaneId","sequence")
);
CREATE INDEX "NexiIngressOwnerSource_instanceId_sequence_idx" ON "NexiIngressOwnerSource" ("instanceId","sequence");
CREATE TABLE "NexiIngressOwnerDelivery" (
  "sourceJournalId" VARCHAR(36) PRIMARY KEY REFERENCES "NexiIngressOwnerSource"("id"),
  "deliveryJournalId" VARCHAR(36) NOT NULL UNIQUE,
  "generationId" VARCHAR(36) NOT NULL REFERENCES "NexiIngressOwnerGeneration"("id"),
  "sourceSequence" BIGINT NOT NULL,
  "deliverySequence" BIGINT NOT NULL CHECK ("deliverySequence">"sourceSequence"),
  "sourceProofDigest" VARCHAR(64) NOT NULL,
  FOREIGN KEY ("deliveryJournalId") REFERENCES "NexiIngressJournal"("id") DEFERRABLE INITIALLY DEFERRED,
  CHECK ("sourceJournalId"="deliveryJournalId")
);

CREATE FUNCTION nexi_ingress_owner_root_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'nexi_ingress_owner_root_permanent'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."revision"<>0 OR NEW."activeGenerationId" IS NOT NULL OR NEW."sourceFloorSequence" IS NOT NULL
    THEN RAISE EXCEPTION 'nexi_ingress_owner_root_initial'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."id",NEW."scopeId",NEW."instanceId",NEW."sessionIdentity",NEW."pnJid") IS DISTINCT FROM
      ROW(OLD."id",OLD."scopeId",OLD."instanceId",OLD."sessionIdentity",OLD."pnJid")
    OR NEW."revision"<>OLD."revision"+1
    OR (OLD."sourceFloorSequence" IS NOT NULL AND NEW."sourceFloorSequence" IS DISTINCT FROM OLD."sourceFloorSequence")
  THEN RAISE EXCEPTION 'nexi_ingress_owner_root_immutable'; END IF;
  IF NEW."activeGenerationId" IS DISTINCT FROM OLD."activeGenerationId" AND NOT EXISTS (
    SELECT 1 FROM "NexiIngressOwnerGeneration" g
    WHERE g."id"=NEW."activeGenerationId" AND g."rootLaneId"=OLD."id" AND g."scopeId"=OLD."scopeId"
      AND g."instanceId"=OLD."instanceId" AND g."sessionIdentity"=OLD."sessionIdentity"
      AND g."rootRevision"=OLD."revision" AND g."installedAt" IS NOT NULL AND g."approval" IS NOT NULL
      AND g."oldLaneId"=COALESCE((SELECT previous."newLaneId" FROM "NexiIngressOwnerGeneration" previous
        WHERE previous."id"=OLD."activeGenerationId"),OLD."id"))
  THEN RAISE EXCEPTION 'nexi_ingress_owner_generation_uninstalled'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nexi_ingress_owner_root_guard BEFORE INSERT OR UPDATE OR DELETE ON "NexiIngressOwnerRoot"
  FOR EACH ROW EXECUTE FUNCTION nexi_ingress_owner_root_guard();
CREATE TRIGGER nexi_ingress_owner_root_no_truncate BEFORE TRUNCATE ON "NexiIngressOwnerRoot"
  FOR EACH STATEMENT EXECUTE FUNCTION nexi_ingress_owner_root_guard();

CREATE FUNCTION nexi_ingress_owner_generation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'nexi_ingress_owner_generation_permanent'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."approval" IS NOT NULL OR NEW."installedAt" IS NOT NULL OR NEW."frozenLaneId" IS NOT NULL
      OR NEW."registration" IS NOT NULL OR NEW."registeredAt" IS NOT NULL
    THEN RAISE EXCEPTION 'nexi_ingress_owner_candidate_initial'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['approval','installedAt','frozenLaneId','registration','registeredAt']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['approval','installedAt','frozenLaneId','registration','registeredAt'])
  THEN RAISE EXCEPTION 'nexi_ingress_owner_candidate_immutable'; END IF;
  IF OLD."approval" IS NULL THEN
    IF NEW."approval" IS NULL OR NEW."installedAt" IS NULL OR NEW."frozenLaneId"<>OLD."oldLaneId"
      OR NEW."registration" IS NOT NULL OR NEW."registeredAt" IS NOT NULL
    THEN RAISE EXCEPTION 'nexi_ingress_owner_install_invalid'; END IF;
  ELSIF ROW(NEW."approval",NEW."installedAt",NEW."frozenLaneId") IS DISTINCT FROM
      ROW(OLD."approval",OLD."installedAt",OLD."frozenLaneId") OR OLD."registration" IS NOT NULL
    OR NEW."registration" IS NULL OR NEW."registeredAt" IS NULL
  THEN RAISE EXCEPTION 'nexi_ingress_owner_registration_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nexi_ingress_owner_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON "NexiIngressOwnerGeneration"
  FOR EACH ROW EXECUTE FUNCTION nexi_ingress_owner_generation_guard();
CREATE TRIGGER nexi_ingress_owner_generation_no_truncate BEFORE TRUNCATE ON "NexiIngressOwnerGeneration"
  FOR EACH STATEMENT EXECUTE FUNCTION nexi_ingress_owner_generation_guard();

CREATE FUNCTION nexi_ingress_owner_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source "NexiIngressOwnerSource"%ROWTYPE; root "NexiIngressOwnerRoot"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'nexi_ingress_owner_source_permanent'; END IF;
  IF TG_TABLE_NAME='NexiIngressOwnerSource' THEN
    PERFORM 1 FROM "NexiIngressScope" WHERE "id"=NEW."scopeId" FOR UPDATE;
    SELECT * INTO root FROM "NexiIngressOwnerRoot" WHERE "id"=NEW."rootLaneId";
    IF NOT FOUND OR root."sourceFloorSequence" IS NULL OR NEW."sequence"<=root."sourceFloorSequence"
      OR ROW(NEW."scopeId",NEW."instanceId",NEW."sessionIdentity") IS DISTINCT FROM
        ROW(root."scopeId",root."instanceId",root."sessionIdentity")
      OR NEW."envelope"->'claims'->>'version'<>'1' OR NEW."envelope"->'claims'->>'journal_id'<>NEW."id"
      OR (NEW."envelope"->'claims'->>'accepted_at')::timestamptz<clock_timestamp()-interval '5 minutes'
      OR (NEW."envelope"->'claims'->>'accepted_at')::timestamptz>clock_timestamp()+interval '5 minutes'
      OR EXISTS(SELECT 1 FROM "NexiIngressJournal" j WHERE j."dedupKey"=NEW."dedupKey")
    THEN RAISE EXCEPTION 'nexi_ingress_owner_source_conflict'; END IF;
  ELSE
    SELECT * INTO source FROM "NexiIngressOwnerSource" WHERE "id"=NEW."sourceJournalId";
    IF NOT FOUND THEN RAISE EXCEPTION 'nexi_ingress_owner_source_missing'; END IF;
    PERFORM 1 FROM "NexiIngressScope" WHERE "id"=source."scopeId" FOR UPDATE;
    IF NEW."sourceSequence"<>source."sequence" OR NOT EXISTS (
      SELECT 1 FROM "NexiIngressOwnerGeneration" g JOIN "NexiIngressOwnerRoot" r ON r."id"=g."rootLaneId"
      WHERE g."id"=NEW."generationId" AND g."registeredAt" IS NOT NULL AND g."registration" IS NOT NULL
        AND r."activeGenerationId"=g."id" AND source."rootLaneId"=r."id"
        AND NEW."deliverySequence">g."cutoffSequence" AND source."sequence">r."sourceFloorSequence")
    THEN RAISE EXCEPTION 'nexi_ingress_owner_delivery_unregistered'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nexi_ingress_owner_source_guard BEFORE INSERT OR UPDATE OR DELETE ON "NexiIngressOwnerSource"
  FOR EACH ROW EXECUTE FUNCTION nexi_ingress_owner_source_guard();
CREATE TRIGGER nexi_ingress_owner_source_no_truncate BEFORE TRUNCATE ON "NexiIngressOwnerSource"
  FOR EACH STATEMENT EXECUTE FUNCTION nexi_ingress_owner_source_guard();
CREATE TRIGGER nexi_ingress_owner_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON "NexiIngressOwnerDelivery"
  FOR EACH ROW EXECUTE FUNCTION nexi_ingress_owner_source_guard();
CREATE TRIGGER nexi_ingress_owner_delivery_no_truncate BEFORE TRUNCATE ON "NexiIngressOwnerDelivery"
  FOR EACH STATEMENT EXECUTE FUNCTION nexi_ingress_owner_source_guard();

-- The crypto verifier is in trusted provider code with a pinned APP Ed25519
-- public key. SQL supplies permanence/fencing, not an approval signing oracle.
CREATE FUNCTION nexi_ingress_owner_prefix_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE lane text; source "NexiIngressOwnerSource"%ROWTYPE;
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'nexi_ingress_history_permanent'; END IF;
  IF TG_TABLE_NAME='NexiIngressJournal' AND TG_OP='DELETE'
  THEN RAISE EXCEPTION 'nexi_ingress_history_permanent'; END IF;
  IF TG_TABLE_NAME='NexiIngressJournal' AND TG_OP='UPDATE' AND
    ROW(NEW."id",NEW."dedupKey",NEW."scopeId",NEW."laneId",NEW."instanceId",NEW."sessionIdentity",NEW."sequence",NEW."envelope")
      IS DISTINCT FROM
    ROW(OLD."id",OLD."dedupKey",OLD."scopeId",OLD."laneId",OLD."instanceId",OLD."sessionIdentity",OLD."sequence",OLD."envelope")
  THEN RAISE EXCEPTION 'nexi_ingress_original_proof_immutable'; END IF;
  IF TG_TABLE_NAME='NexiIngressLane' THEN lane:=OLD."id";
  ELSIF TG_OP='INSERT' THEN
    -- Baseline APPEND uses this same scope lock. Even an older provider image
    -- cannot append into a frozen lane after installing this additive schema.
    PERFORM 1 FROM "NexiIngressScope" WHERE "id"=NEW."scopeId" FOR UPDATE;
    lane:=NEW."laneId";
    SELECT * INTO source FROM "NexiIngressOwnerSource" s WHERE s."dedupKey"=NEW."dedupKey";
    IF FOUND THEN
      IF source."id"<>NEW."id" OR NEW."envelope"->'claims'->>'version'<>'2' OR NOT EXISTS (
        SELECT 1 FROM "NexiIngressOwnerDelivery" d JOIN "NexiIngressOwnerGeneration" g ON g."id"=d."generationId"
        WHERE d."sourceJournalId"=source."id" AND d."deliveryJournalId"=NEW."id" AND d."deliverySequence"=NEW."sequence"
          AND g."newLaneId"=NEW."laneId" AND g."registeredAt" IS NOT NULL
          AND NEW."envelope"->'claims'->'source_proof'=source."envelope"
          AND NEW."envelope"->'claims'->>'source_journal_id'=source."id"
          AND NEW."envelope"->'claims'->>'source_proof_digest'=d."sourceProofDigest"
          AND NEW."payload"=source."payload")
      THEN RAISE EXCEPTION 'nexi_ingress_owner_delivery_conflict'; END IF;
    ELSIF NEW."envelope"->'claims'->>'version'='2' OR EXISTS (
      SELECT 1 FROM "NexiIngressOwnerRoot" r WHERE r."id"=NEW."laneId" AND r."sourceFloorSequence" IS NOT NULL)
    THEN RAISE EXCEPTION 'nexi_ingress_owner_staging_required'; END IF;
  ELSE lane:=OLD."laneId"; END IF;
  IF EXISTS(SELECT 1 FROM "NexiIngressOwnerGeneration" g WHERE g."frozenLaneId"=lane)
  THEN RAISE EXCEPTION 'nexi_ingress_owner_prefix_quarantined'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nexi_ingress_owner_frozen_journal BEFORE INSERT OR UPDATE OR DELETE ON "NexiIngressJournal"
  FOR EACH ROW EXECUTE FUNCTION nexi_ingress_owner_prefix_guard();
CREATE TRIGGER nexi_ingress_owner_frozen_lane BEFORE UPDATE OR DELETE ON "NexiIngressLane"
  FOR EACH ROW EXECUTE FUNCTION nexi_ingress_owner_prefix_guard();
CREATE TRIGGER nexi_ingress_owner_journal_no_truncate BEFORE TRUNCATE ON "NexiIngressJournal"
  FOR EACH STATEMENT EXECUTE FUNCTION nexi_ingress_owner_prefix_guard();
CREATE TRIGGER nexi_ingress_owner_lane_no_truncate BEFORE TRUNCATE ON "NexiIngressLane"
  FOR EACH STATEMENT EXECUTE FUNCTION nexi_ingress_owner_prefix_guard();
