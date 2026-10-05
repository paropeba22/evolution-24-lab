-- Secondary physical transport state. No Message/Instance FK; deletion must

-- not free a managed classification, reservation correlation or receipt identity.

CREATE TABLE "NexiManagedTransportContext" (
  "id" VARCHAR(36) NOT NULL,
  "instanceId" VARCHAR(100) NOT NULL,
  "instanceName" VARCHAR(100) NOT NULL,
  "managedChannelId" VARCHAR(32) NOT NULL,
  "sessionIdentity" VARCHAR(64) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY ("id")
);

CREATE TABLE "NexiAttendancePreparation" (
  "id" VARCHAR(36) NOT NULL,
  "instanceId" VARCHAR(100) NOT NULL,
  "instanceName" VARCHAR(100) NOT NULL,
  "executionId" VARCHAR(36) NOT NULL,
  "attemptId" VARCHAR(36),
  "transportUnit" INTEGER NOT NULL,
  "requestId" VARCHAR(36) NOT NULL,
  "inputDigest" VARCHAR(64) NOT NULL,
  "requests" JSONB NOT NULL,
  "authority" JSONB NOT NULL,
  "intent" JSONB NOT NULL,
  "authorityDigest" VARCHAR(64) NOT NULL,
  "payloadDigest" VARCHAR(64) NOT NULL,
  "recipient" VARCHAR(128) NOT NULL,
  "sessionIdentity" VARCHAR(64) NOT NULL,
  "externalId" VARCHAR(512) NOT NULL,
  "reservationId" VARCHAR(36),
  "preparationNonce" VARCHAR(64) NOT NULL,
  "preparationRevision" INTEGER NOT NULL,
  "contentDigest" VARCHAR(64),
  "preparationDigest" VARCHAR(64),
  "admissionId" VARCHAR(36),
  "releaseId" VARCHAR(36),
  "releaseConsumedAt" TIMESTAMP(3),
  "dispatchStartedAt" TIMESTAMP(3),
  "transportReturn" JSONB,
  "outcomeUnknown" BOOLEAN NOT NULL DEFAULT FALSE,
  "state" VARCHAR(32) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "reservedAt" TIMESTAMP(3),
  "frozenAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "closureReason" VARCHAR(64),
  "successorId" VARCHAR(36),
  "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
  "nextRecoveryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  "lastRecoveryReason" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY ("id"),
  CONSTRAINT "NexiAttendancePreparation_unit" CHECK ("transportUnit" >= 0 AND "preparationRevision" > 0 AND "revision" >= 0),
  CONSTRAINT "NexiAttendancePreparation_no_dispatch" CHECK ("dispatchStartedAt" IS NULL AND "releaseConsumedAt" IS NULL AND "transportReturn" IS NULL AND "state" IN ('draft','reserved','prepared','awaiting_admission','outcome_unknown','definitively_not_sent')),
  CONSTRAINT "NexiAttendancePreparation_unknown" CHECK (("state" = 'outcome_unknown') = "outcomeUnknown")
);

CREATE TABLE "NexiReceiptJournal" (
  "id" VARCHAR(36) NOT NULL,
  "instanceId" VARCHAR(100) NOT NULL,
  "sessionIdentity" VARCHAR(64) NOT NULL,
  "sourceKey" VARCHAR(64) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "externalId" VARCHAR(512) NOT NULL,
  "normalizedStatus" VARCHAR(16) NOT NULL,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY ("id")
);

CREATE TABLE "NexiAttendanceEventOutbox" (
  "id" VARCHAR(36) NOT NULL,
  "instanceId" VARCHAR(100) NOT NULL,
  "instanceName" VARCHAR(100) NOT NULL,
  "sessionIdentity" VARCHAR(64) NOT NULL,
  "eventType" VARCHAR(64) NOT NULL,
  "version" INTEGER NOT NULL,
  "sourceKey" VARCHAR(64) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "body" JSONB NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "leaseToken" VARCHAR(36),
  "leaseUntil" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY ("id")
);

CREATE TABLE "NexiAttendanceHealth" (
  "instanceId" VARCHAR(100) NOT NULL,
  "unhealthy" BOOLEAN NOT NULL DEFAULT TRUE,
  "reason" VARCHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "firstGapAt" TIMESTAMP(3) NOT NULL,
  "lastGapAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("instanceId")
);

CREATE UNIQUE INDEX "NexiManagedTransportContext_fingerprint_key" ON "NexiManagedTransportContext" ("fingerprint");

CREATE INDEX "NexiManagedTransportContext_instanceId_createdAt_idx" ON "NexiManagedTransportContext" ("instanceId", "createdAt");

CREATE UNIQUE INDEX "NexiAttendancePreparation_instanceId_requestId_key" ON "NexiAttendancePreparation" ("instanceId", "requestId");

CREATE UNIQUE INDEX "NexiAttendancePreparation_instanceId_externalId_key" ON "NexiAttendancePreparation" ("instanceId", "externalId");

CREATE INDEX "NexiAttendancePreparation_instanceId_state_idx" ON "NexiAttendancePreparation" ("instanceId", "state");

CREATE UNIQUE INDEX "NexiReceiptJournal_instanceId_sourceKey_key" ON "NexiReceiptJournal" ("instanceId", "sourceKey");

CREATE INDEX "NexiReceiptJournal_instanceId_externalId_idx" ON "NexiReceiptJournal" ("instanceId", "externalId");

CREATE UNIQUE INDEX "NexiAttendanceEventOutbox_instanceId_sourceKey_key" ON "NexiAttendanceEventOutbox" ("instanceId", "sourceKey");

CREATE INDEX "NexiAttendanceEventOutbox_state_nextAttemptAt_idx" ON "NexiAttendanceEventOutbox" ("state", "nextAttemptAt");

CREATE FUNCTION nexi_attendance_permanent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'nexi_attendance_permanent'; END $$;

CREATE TRIGGER nexi_attendance_no_delete BEFORE DELETE ON "NexiManagedTransportContext" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_no_truncate BEFORE TRUNCATE ON "NexiManagedTransportContext" FOR EACH STATEMENT EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_immutable BEFORE UPDATE ON "NexiManagedTransportContext" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_no_delete BEFORE DELETE ON "NexiAttendancePreparation" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_no_truncate BEFORE TRUNCATE ON "NexiAttendancePreparation" FOR EACH STATEMENT EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_no_delete BEFORE DELETE ON "NexiReceiptJournal" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_no_truncate BEFORE TRUNCATE ON "NexiReceiptJournal" FOR EACH STATEMENT EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_immutable BEFORE UPDATE ON "NexiReceiptJournal" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_no_delete BEFORE DELETE ON "NexiAttendanceEventOutbox" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_no_truncate BEFORE TRUNCATE ON "NexiAttendanceEventOutbox" FOR EACH STATEMENT EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_no_delete BEFORE DELETE ON "NexiAttendanceHealth" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_permanent();

CREATE TRIGGER nexi_attendance_no_truncate BEFORE TRUNCATE ON "NexiAttendanceHealth" FOR EACH STATEMENT EXECUTE FUNCTION nexi_attendance_permanent();

CREATE FUNCTION nexi_attendance_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
 OR (OLD.state='prepared' AND NEW.state IN ('awaiting_admission','outcome_unknown')))
 THEN RAISE EXCEPTION 'nexi_attendance_preparation_no_reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER nexi_attendance_preparation BEFORE UPDATE ON "NexiAttendancePreparation" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_preparation_guard();

CREATE FUNCTION nexi_attendance_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."id",NEW."instanceId",NEW."instanceName",NEW."sessionIdentity",NEW."eventType",NEW."version",NEW."sourceKey",NEW."fingerprint",NEW."body",NEW."createdAt") IS DISTINCT FROM ROW(OLD."id",OLD."instanceId",OLD."instanceName",OLD."sessionIdentity",OLD."eventType",OLD."version",OLD."sourceKey",OLD."fingerprint",OLD."body",OLD."createdAt")
 OR NEW.attempts<OLD.attempts OR (OLD.state='acknowledged' AND NEW.state<>OLD.state)
 OR (OLD."acknowledgedAt" IS NOT NULL AND NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt")
 THEN RAISE EXCEPTION 'nexi_attendance_outbox_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER nexi_attendance_outbox BEFORE UPDATE ON "NexiAttendanceEventOutbox" FOR EACH ROW EXECUTE FUNCTION nexi_attendance_outbox_guard();
