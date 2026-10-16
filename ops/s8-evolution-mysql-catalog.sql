-- S8: prepared only. Requires confirmed MySQL Evolution NEXI database.
-- If _prisma_migrations is absent, stop and investigate; do not initialize it.
START TRANSACTION READ ONLY;
SELECT DATABASE() AS database_name,CURRENT_USER() AS database_role,VERSION() AS version,@@max_connections AS max_connections;
SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count
FROM _prisma_migrations ORDER BY started_at;
SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN
  ('NexiIngressScope','NexiIngressLane','NexiIngressJournal','NexiIngressEffectLane','NexiIngressEffect','NexiIngressContactCache','NexiAttendancePreparation');
SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
  AND TABLE_NAME IN ('NexiIngressJournal','NexiIngressEffect','NexiIngressContactCache')
ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX;
SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()
  AND EVENT_OBJECT_TABLE IN ('NexiAttendancePreparation','NexiAttendanceEventOutbox','NexiManagedTransportContext');
ROLLBACK;
