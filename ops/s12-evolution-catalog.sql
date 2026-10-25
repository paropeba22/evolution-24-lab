-- PREPARED, NOT EXECUTED. PostgreSQL 18 catalog capture for the NEXI nexi DB.
-- Use an independently authorized administrative READ ONLY connection.
-- No application rows, statement texts, passwords, key material or setting
-- values other than the explicit safe allowlist below are selected.
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='1s';
DO $$ BEGIN
  IF current_database()<>'nexi' OR current_setting('server_version_num')::int NOT BETWEEN 180000 AND 189999
  THEN RAISE EXCEPTION 'expected NEXI nexi database on PostgreSQL 18'; END IF;
END $$;
SELECT current_database(),(SELECT oid FROM pg_database WHERE datname=current_database()) AS database_oid,
       session_user,current_user,current_setting('server_version_num') AS server_version_num,
       current_setting('search_path') AS search_path,current_setting('session_replication_role') AS replication_role;
SELECT datname,datdba::regrole AS owner,datacl FROM pg_database WHERE datname=current_database();
SELECT oid,rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
       rolconnlimit,rolvaliduntil FROM pg_roles ORDER BY rolname;
SELECT roleid::regrole AS granted_role,member::regrole AS member,grantor::regrole AS grantor,
       admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor;
SELECT d.setdatabase,d.setrole::regrole AS role,
       split_part(v,'=',1) AS setting_name,
       CASE WHEN split_part(v,'=',1) IN ('search_path','session_replication_role','statement_timeout','lock_timeout')
            THEN substr(v,strpos(v,'=')+1) ELSE '[value omitted]' END AS setting_value
FROM pg_db_role_setting d CROSS JOIN LATERAL unnest(d.setconfig) v
WHERE d.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
ORDER BY d.setdatabase,d.setrole,setting_name;
SELECT parname,paracl FROM pg_parameter_acl ORDER BY parname;
SELECT n.oid,n.nspname,n.nspowner::regrole AS owner,n.nspacl
FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname;
SELECT n.nspname,c.relname,c.relkind,c.relowner::regrole AS owner,c.relacl,c.relrowsecurity,c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
ORDER BY n.nspname,c.relname;
SELECT n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,
       a.attnotnull,a.attidentity,a.attgenerated,a.attacl,d.oid IS NOT NULL AS has_default,
       md5(pg_get_expr(d.adbin,d.adrelid)) AS default_definition_md5
FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
ORDER BY n.nspname,c.relname,a.attnum;
-- Default expressions can contain literals: record hashes plus dependency names.
SELECT n.nspname,c.relname,a.attname,d.refclassid::regclass AS dependency_catalog,
       CASE WHEN d.refclassid='pg_class'::regclass THEN d.refobjid::regclass::text
            WHEN d.refclassid='pg_proc'::regclass THEN d.refobjid::regprocedure::text
            WHEN d.refclassid='pg_type'::regclass THEN d.refobjid::regtype::text END AS dependency
FROM pg_attrdef ad JOIN pg_class c ON c.oid=ad.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ad.adnum
JOIN pg_depend d ON d.classid='pg_attrdef'::regclass AND d.objid=ad.oid
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY 1,2,3,4,5;
SELECT ns.nspname AS sequence_schema,s.relname AS sequence_name,s.relowner::regrole AS owner,s.relacl,
       nt.nspname AS table_schema,t.relname AS table_name,a.attname AS column_name,d.deptype
FROM pg_class s JOIN pg_namespace ns ON ns.oid=s.relnamespace
LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid
  AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_namespace nt ON nt.oid=t.relnamespace
LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
WHERE s.relkind='S' AND ns.nspname NOT LIKE 'pg_%' ORDER BY 1,2;
SELECT n.nspname,c.relname,k.conname,k.contype,k.convalidated,k.condeferrable,k.condeferred,
       k.confrelid::regclass AS referenced_relation,k.confupdtype,k.confdeltype,k.conkey,k.confkey,
       md5(pg_get_constraintdef(k.oid)) AS definition_md5
FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY 1,2,3;
SELECT n.nspname,c.relname,i.indexrelid::regclass AS index_name,i.indisunique,i.indisvalid,i.indisready,
       i.indkey,i.indpred IS NULL AS unconditional,md5(pg_get_indexdef(i.indexrelid)) AS definition_md5
FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY 1,2,3;
SELECT n.nspname,p.oid::regprocedure AS function,p.proowner::regrole AS owner,p.prosecdef,p.proacl,
       p.prorettype::regtype AS return_type,l.lanname,md5(p.prosrc) AS source_md5,
       ARRAY(SELECT split_part(v,'=',1) FROM unnest(p.proconfig) v ORDER BY v) AS setting_names,
       ARRAY(SELECT v FROM unnest(p.proconfig) v WHERE split_part(v,'=',1)='search_path') AS search_path_setting,
       e.extname AS extension
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
LEFT JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
LEFT JOIN pg_extension e ON d.refclassid='pg_extension'::regclass AND e.oid=d.refobjid
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY 1,2;
SELECT n.nspname,c.relname,t.tgname,t.tgfoid::regprocedure AS function,t.tgenabled,t.tgtype,
       t.tgisinternal,t.tgnargs,t.tgdeferrable,t.tginitdeferred,t.tgqual IS NULL AS unqualified,
       md5(pg_get_triggerdef(t.oid)) AS definition_md5
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY 1,2,3;
SELECT extname,extversion,extowner::regrole AS owner,extnamespace::regnamespace AS schema
FROM pg_extension ORDER BY extname;
SELECT defaclrole::regrole AS creator,defaclnamespace::regnamespace AS schema,defaclobjtype,defaclacl
FROM pg_default_acl ORDER BY 1,2,3;
SELECT n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles,
       md5(pg_get_expr(p.polqual,p.polrelid)) AS using_md5,
       md5(pg_get_expr(p.polwithcheck,p.polrelid)) AS check_md5
FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace ORDER BY 1,2,3;
-- No query text and no application data. application_name is omitted.
SELECT datname,usename,client_addr,state,count(*) AS connections FROM pg_stat_activity
WHERE datname=current_database() GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count
FROM public."_prisma_migrations" ORDER BY started_at,migration_name;
ROLLBACK;
