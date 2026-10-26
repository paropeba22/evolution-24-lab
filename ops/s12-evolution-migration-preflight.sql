-- PREPARED, NEVER EXECUTED. Read-only gate for the separately approved direct
-- Prisma maintenance connection, AFTER role provisioning, BEFORE owner DDL.
-- psql -X: supply only a nonsecret expected_database_oid. Credentials belong in
-- the approved secret channel, never argv, this file, output or shell traces.
\set ON_ERROR_STOP on
\if :{?expected_database_oid}
\else
  \echo 'STOP: exact catalog-approved database OID is required.'
  \quit 3
\endif
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='1s';
SELECT set_config('nexi.expected_database_oid', :'expected_database_oid', true) AS expected_database_oid;
-- Deliberately do not SET ROLE here: that would hide a broken login default.
DO $$ BEGIN
  IF current_database()<>'nexi' OR current_setting('server_version_num')::int NOT BETWEEN 180000 AND 189999
    OR (SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
      <>current_setting('nexi.expected_database_oid')::oid
    OR session_user<>'nexi_evolution_migrator' OR current_user<>'nexi_evolution_guard_owner'
    OR current_setting('session_replication_role')<>'origin'
    OR current_schemas(false)<>ARRAY['public']::name[] OR pg_my_temp_schema()<>0
  THEN RAISE EXCEPTION 'migration database, login-default role, origin or path mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND NOT rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  THEN RAISE EXCEPTION 'owner or migration-login attributes unsafe'; END IF;
  -- Check every edge incident to the four protected roles, in both directions.
  -- Only migrator -> {schema_owner,guard_owner} with SET true, INHERIT/ADMIN
  -- false is allowed. Any third-party path must cross an incident edge, so
  -- rejecting all other such edges also rejects indirect SET/INHERIT/ADMIN
  -- access. Do not filter by enabled options or exempt administrative members.
  -- Runtime may still be NOLOGIN here: its credential ceremony is separate.
  IF (SELECT count(*) FROM pg_catalog.pg_roles
      WHERE rolname IN ('nexi_evolution_schema_owner','nexi_evolution_guard_owner',
        'nexi_evolution_migrator','nexi_evolution_runtime')
        AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls
        AND (rolname NOT IN ('nexi_evolution_schema_owner','nexi_evolution_guard_owner') OR NOT rolcanlogin))<>4
    OR (SELECT count(*) FROM pg_catalog.pg_auth_members a
      JOIN pg_catalog.pg_roles member ON member.oid=a.member
      JOIN pg_catalog.pg_roles owner ON owner.oid=a.roleid
      WHERE member.rolname='nexi_evolution_migrator'
        AND owner.rolname IN ('nexi_evolution_schema_owner','nexi_evolution_guard_owner')
        AND a.set_option AND NOT a.inherit_option AND NOT a.admin_option)<>2
    OR (SELECT count(DISTINCT a.roleid) FROM pg_catalog.pg_auth_members a
      JOIN pg_catalog.pg_roles member ON member.oid=a.member
      WHERE member.rolname='nexi_evolution_migrator')<>2
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members a
      JOIN pg_catalog.pg_roles member ON member.oid=a.member
      JOIN pg_catalog.pg_roles owner ON owner.oid=a.roleid
      WHERE (member.rolname IN ('nexi_evolution_schema_owner','nexi_evolution_guard_owner',
          'nexi_evolution_migrator','nexi_evolution_runtime')
        OR owner.rolname IN ('nexi_evolution_schema_owner','nexi_evolution_guard_owner',
          'nexi_evolution_migrator','nexi_evolution_runtime'))
        AND (member.rolname<>'nexi_evolution_migrator'
          OR owner.rolname NOT IN ('nexi_evolution_schema_owner','nexi_evolution_guard_owner')
          OR NOT a.set_option OR a.inherit_option OR a.admin_option))
  THEN RAISE EXCEPTION 'unexpected owner, migrator or runtime role graph'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_db_role_setting d JOIN pg_catalog.pg_roles r ON r.oid=d.setrole
    JOIN pg_catalog.pg_database db ON db.oid=d.setdatabase
    WHERE r.rolname=session_user AND db.datname=current_database()
      AND 'role=nexi_evolution_guard_owner'=ANY(d.setconfig)
      AND 'search_path=public'=ANY(d.setconfig) AND 'session_replication_role=origin'=ANY(d.setconfig))
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members a
      JOIN pg_catalog.pg_roles member ON member.oid=a.member JOIN pg_catalog.pg_roles owner ON owner.oid=a.roleid
      WHERE member.rolname=session_user AND owner.rolname=current_user
        AND a.set_option AND NOT a.inherit_option AND NOT a.admin_option)
  THEN RAISE EXCEPTION 'server-enforced per-database login identity contract absent'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pgcrypto')
    OR to_regnamespace('nexi_ingress_owner_private') IS NOT NULL
    OR to_regclass('public."NexiIngressOwnerRoot"') IS NOT NULL
    OR to_regclass('public."NexiIngressOwnerGeneration"') IS NOT NULL
    OR to_regclass('public."NexiIngressOwnerSource"') IS NOT NULL
    OR to_regclass('public."NexiIngressOwnerDelivery"') IS NOT NULL
  THEN RAISE EXCEPTION 'not the reviewed pre-migration baseline'; END IF;
  IF NOT has_database_privilege(current_user,current_database(),'CREATE')
    OR NOT has_schema_privilege(current_user,'public','CREATE')
    OR NOT has_table_privilege(current_user,'public."NexiIngressScope"','REFERENCES')
    OR NOT has_table_privilege(current_user,'public."NexiIngressLane"','REFERENCES')
    OR NOT has_table_privilege(current_user,'public."NexiIngressJournal"','REFERENCES')
    OR NOT has_table_privilege(current_user,'public."NexiIngressLane"','TRIGGER')
    OR NOT has_table_privilege(current_user,'public."NexiIngressJournal"','TRIGGER')
    OR NOT has_table_privilege(current_user,'public."_prisma_migrations"','SELECT')
    OR NOT has_table_privilege(current_user,'public."_prisma_migrations"','INSERT')
    OR NOT has_table_privilege(current_user,'public."_prisma_migrations"','UPDATE')
  THEN RAISE EXCEPTION 'reviewed temporary migration capabilities absent'; END IF;
  IF EXISTS(SELECT 1 FROM public."_prisma_migrations" WHERE rolled_back_at IS NULL AND finished_at IS NULL)
    OR EXISTS(SELECT 1 FROM public."_prisma_migrations"
      WHERE migration_name='20261025000000_nexi_ingress_owner_generations' AND rolled_back_at IS NULL)
  THEN RAISE EXCEPTION 'migration ledger unresolved or target already recorded'; END IF;
END $$;
-- Reject missing/unknown history before a future migrate deploy can replay it.
-- The fragment creates nothing and requires this active READ ONLY transaction.
\ir s12-evolution-baseline-ledger-contract.sql
SELECT session_user AS login,current_user AS effective_owner,current_database() AS database,
       current_setting('role') AS active_role,current_setting('session_replication_role') AS replication_role;
ROLLBACK;
-- This gate observes one new connection. The database-role defaults apply at
-- authentication to EVERY direct connection made with this same migrator login,
-- including Prisma's separate engine/ledger sessions. A SET ROLE in a preceding
-- psql process or one pooled client would not propagate and is not this contract.
-- Reject URI startup role/options overrides, PGOPTIONS, transaction poolers,
-- engine paths that RESET ROLE NONE, runtime URLs, or a different login. The
-- exact final engine/version and complete artifact/ledger comparison remain
-- separate gates; passing this read-only check never authorizes migrate deploy.
