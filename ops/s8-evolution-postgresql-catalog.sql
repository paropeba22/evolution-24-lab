-- S8: prepared only. Requires confirmed Evolution NEXI database, never BIA.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT current_database() AS database_name, current_schema() AS schema_name, current_user AS database_role,
       current_setting('server_version') AS version,
       current_setting('max_connections') AS max_connections;
SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
FROM "_prisma_migrations" ORDER BY started_at;
SELECT name, to_regclass('"' || name || '"') AS relation FROM unnest(ARRAY[
  'NexiIngressScope','NexiIngressLane','NexiIngressJournal','NexiIngressEffectLane',
  'NexiIngressEffect','NexiIngressContactCache','NexiAttendancePreparation',
  'NexiAttendanceEventOutbox','NexiManagedTransportContext'
]) AS name;
SELECT t.relname AS table_name,c.relname AS index_name,i.indisvalid,i.indisready
FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname=current_schema() AND t.relname IN ('NexiIngressJournal','NexiIngressEffect','NexiIngressContactCache')
ORDER BY t.relname,c.relname;
SELECT c.relname AS table_name,t.tgname,t.tgenabled,p.proname AS function_name
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND c.relname IN ('NexiAttendancePreparation','NexiAttendanceEventOutbox','NexiManagedTransportContext')
ORDER BY c.relname,t.tgname;
ROLLBACK;
