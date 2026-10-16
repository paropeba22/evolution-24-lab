-- S8: prepared only. Run later on the explicitly identified NEXI APP database.
-- No message bodies, credentials, contact identifiers or SQL query texts.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT current_database() AS database_name, current_schema() AS schema_name, current_user AS database_role,
       current_setting('server_version') AS version,
       current_setting('max_connections') AS max_connections;
SELECT version FROM schema_migrations ORDER BY version;
SELECT name, to_regclass(name) AS relation FROM unnest(ARRAY[
  'channel_whatsapp_ingress_admissions', 'channel_whatsapp_associations',
  'channel_whatsapp_evidences', 'nexi_attendance_works',
  'nexi_attendance_orchestrations', 'nexi_attendance_receipts',
  'nexi_attendance_receipt_applications', 'nexi_outbound_attempts',
  'nexi_outbound_external_id_reservations', 'managed_channel_writer_barriers'
]) AS name;
SELECT n.nspname AS schema_name, c.relname AS index_name,
       i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname=current_schema() AND c.relname IN ('attendance_work_identity','attendance_work_due','attendance_receipt_correlation_lookup',
                   'idx_wa_ingress_evidence','idx_wa_ingress_journal','idx_wa_ingress_source')
ORDER BY c.relname;
SELECT n.nspname AS schema_name, c.relname AS table_name, t.tgname, t.tgenabled,
       p.proname AS function_name
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND (t.tgname LIKE 'attendance_%' OR t.tgname LIKE 'channel_wa_%')
ORDER BY c.relname,t.tgname;
SELECT state, count(*) FROM pg_stat_activity WHERE datname=current_database() GROUP BY state;
ROLLBACK;
