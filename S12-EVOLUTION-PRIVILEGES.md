# S12 Evolution Prisma provenance and privilege preparation

Status: **PREPARED / NOT EXECUTED / NOT READY FOR PRODUCTION APPLICATION**.
Static work only on 2026-10-25. No tests, builds, compilers, package installation,
service/DB/Redis/Docker execution, production queries, role changes, migration,
deployment, message processing or activation were performed in this preparation.

The exact session JSONL for chat `01a1745f-11cc-7443-9c40-ece108c529a6`
independently records `turn_context.model=gpt-6.1-sol`, `effort=high`.
The candidate was clean on branch `candidate/s12-ingress-owner-cutover-protocol`,
HEAD `87a82765f52ad9945f9bf52562e99c84e1ad6a49` before these documentation additions.
No application code, migration, guard, signature or HMAC behavior is changed here.

## Evidence boundaries

The runtime observations below were supplied in the assignment, from approximately
2026-10-25 18:25–18:31 UTC (15:25–15:31 America/Sao_Paulo); they were not recaptured
by this preparation. The observed image is
`ghcr.io/paropeba22/nexi-evolution-s12-dispatch-bound-f248f1e@sha256:37bec98093e3a83b20cee3eb249379e325651c8cdc68bcf775f633515e620cf0`,
but its `GIT_SHA` is `b206baaa0518ba881fade671942a693ca1c24188`.
Neither the tag nor this environment value establishes the complete overlay revision.

PostgreSQL 18, database `nexi`, had three idle Evolution connections from
`10.0.1.36` as `postgres`. That login has SUPERUSER, CREATEDB, CREATEROLE,
REPLICATION and BYPASSRLS and is incompatible with the owner-generation gate.
The new NOLOGIN guard owner was absent. The last reported applied Prisma migrations
were `20261015000000`, `20261015000001`, `20261015000002`, at
2026-10-19 21:11:34Z. The new owner-generation migration was absent/unapplied.

Existing reported ingress tables were Scope, Lane, Journal, EffectLane, Effect and
ContactCache; attendance tables also exist, but a full catalog list was not supplied.
Root/Generation/Source/Delivery were absent. Reported journal states were 3
`outcome_unknown/chatwoot_inflight`, 92 `outcome_unknown/identity_pending`, 650
`pending/persisted`, 4 `recoverable_failure/identity_pending`, 436
`succeeded/completed`; 152 lanes, 749 pending, no active leases. These counts do
not authorize replay, clearing, reclassification or bypassing uncertain work.

Only hashes, not the deployed schema bytes/model list, were supplied:

| Deployed file | Reported SHA-256 |
| --- | --- |
| `/evolution/prisma/postgresql-schema.prisma` | `145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f` |
| `/evolution/prisma.config.ts` | `9615adcd624567b61043880dac5ee19441a7c0b2760057c70057b4a7fec99904` |

Candidate `prisma.config.ts`, normalized CRLF→LF, hashes to the reported config
hash exactly. Its raw Windows worktree bytes hash to
`b177ec73269d47d2aa37c6f8a4d2b372119c0dda08bd6eb786460961d61efb6a`.
Git blob `22e28198245c32e9906bf8d3f624a374e9043748` is identical at `b206baaa`,
`f248f1ede50ec2d5519cef0ba4c391a49d6124b4`, and the approved candidate.
This proves config consistency, not deployed schema or artifact provenance.
The schema patch inputs (`patch-prisma-binding.mjs`, group/attendance/ingress
schema patchers, `attendance-models.prisma`, `ingress-models.prisma`) do not differ
between `b206baaa` and `f248f1e`. A matching baseline schema alone therefore could
not distinguish those revisions. Their application behavior does differ.

## Schema and migration path reconciliation

The overlay Dockerfile fetches upstream commit
`e273b904d53f5726970fd6a244ed9caa61dfeb9a`. Exact Git objects from the local
`evolution-reference` checkout were read and archived for static inspection;
the GitHub connector and direct immutable raw URL reads could not retrieve these
files. No upstream source was inferred or reconstructed from memory.

The builder patches upstream schemas in this order: inbox binding, groups,
attendance, ingress, then generates Prisma clients and provider bundles. It copies
the resulting `prisma/` tree into the final image. This overlay repository has
schema fragments and patchers, not a complete committed PostgreSQL schema.
No assembled schema was synthesized here as a substitute for deployed bytes.

`prisma.config.ts` selects `prisma/postgresql-schema.prisma` by default,
`prisma/psql_bouncer-schema.prisma` for `psql_bouncer`, and the MySQL schema for
`mysql`. It sets `migrations.path=prisma/migrations` and reads only
`DATABASE_CONNECTION_URI`. `DATABASE_URL` being unset is therefore not itself a
missing-config diagnosis. Never display either connection URI.

At the pinned upstream revision, `package.json`'s Unix `db:deploy` script asks
`runWithProvider.js` to remove the staging `prisma/migrations` directory, copy
`prisma/DATABASE_PROVIDER-migrations` into it, then run Prisma migrate deploy with
the selected schema. The wrapper substitutes the provider and maps
`psql_bouncer-migrations` to `postgresql-migrations`. This explains how the provider
trees feed the config's migration path. A direct Prisma invocation does not perform
that copy. The upstream Windows deployment script uses `xcopy` without the Unix
cleanup and is not evidence for a clean Linux staging tree.

**Runtime path proof is still incomplete.** The final image inherits
`package.json`, `runWithProvider.js`, Prisma dependencies and
`Docker/scripts/deploy_database.sh` from the pinned final base image
`evoapicloud/evolution-api@sha256:65e29aa1a2ca096675825ff8feb3b5bf7fbcb167e368f9282fd80670e8da18a2`;
the Dockerfile does not copy those files from the pinned source builder. It checks
their existence, not their content hash. The deployed copies and any existing
`prisma/migrations` staging tree still need immutable artifact capture. Do not
assume the final base has the exact upstream scripts just inspected.

The candidate `nexi-start.sh` runs the bundle selector and Node runtime only; it
does not invoke migrations or Prisma generation. Some older README startup text
describes a previous startup contract. A separate approved maintenance job must
stage and verify the exact migration tree. Do not run the inherited deploy shell:
its inspected upstream version prints `DATABASE_URL`, and it can migrate/generate.
No migration should occur under runtime credentials.

Capture from the immutable deployed artifact, without executing application code:
schema bytes, config, package scripts, wrapper, deploy script, current staging tree,
provider migrations and lock file, selected bundle/runtime model, and OCI manifest,
config, labels and available build attestations. Verify the digest above, extract
an allowlist of nonsecret metadata, and compare relevant bytes with `b206baaa`,
`f248f1e` and candidate inputs. Never dump the container environment or OCI env
array, connection strings, private keys, application data or arbitrary logs.
The 54-model source inventory below is not the missing deployed model list.

## Objects and access model

`ops/s12-evolution-source-inventory.json` records 37 exact upstream schema models
and 17 overlay model declarations, relations, defaults and direct delegate call
locations. It is a lexical evidence index, **not a grant allowlist**. Patch templates
contain both old and replacement code. Aliases, generic repositories, nested
writes/cascades, raw SQL, provider branches and deployed feature settings require
manual resolution against the final source and production catalogs.

Examples a direct-name scan misses: `base-chatbot.controller.ts` uses
`botRepository`/`settingsRepository`; event controllers use `this.prisma[this.name]`;
attendance code aliases delegates as `db` and passes them to compare/update helpers.
An empty call list for a model does not prove it can be denied. PostgreSQL raw
SQL in Baileys updates `Message`, reads message counts and upserts `Chat.labels`;
Chatwoot/channel services also issue raw SQL. No runtime DDL was identified in
these inspected paths, but that observation does not replace a complete review.

| Object group | Source-backed requirement / constraint |
| --- | --- |
| Instance, Session | Instance lifecycle and auth state read/create/update/delete; deletion can cascade through many baseline relations. Session credentials remain application data, not catalog output. |
| Chat, Contact, Message, MessageUpdate | Receive/history/storage and reset paths include reads, inserts, updates and deletions; raw SQL needs SELECT plus applicable writes, including UPSERT readback. |
| Webhook, Chatwoot, Label, Proxy, Setting | Read/configuration upserts and lifecycle cleanup; exact per-table operations appear in the inventory. |
| Rabbitmq, Nats, Sqs, Kafka, Websocket, Pusher | Dynamic event controller configuration; resolve concrete names and enabled consumers before grants. |
| Typebot, TypebotSetting, OpenaiCreds, OpenaiBot, OpenaiSetting, IntegrationSession, Dify, DifySetting, EvolutionBot, EvolutionBotSetting, Flowise, FlowiseSetting, N8n, N8nSetting, Evoai, EvoaiSetting | Generic chatbot delegates, relations and credentials. Deployment settings and controller bindings decide required access. Do not grant blanket CRUD on all integrations. |
| Media, Template, IsOnWhatsapp | Storage/template/cache operations and relevant instance/message relations; match deployed flags and lifecycle paths. |
| RuntimeConfig | Licensing/config lookup, upsert and deletion appear in pinned upstream source; uses an autoincrement ID. |
| NexiGroupControl / NexiGroupEventOutbox | Control CAS and durable outbox; delegate aliases add operations to direct inventory; Instance FK cascades. Outbox ID is BIGSERIAL. |
| NexiManagedTransportContext / NexiReceiptJournal | SELECT/INSERT with immutable history; no runtime UPDATE/DELETE/TRUNCATE. Resolve aliased creates in final source. |
| NexiAttendancePreparation / NexiAttendanceEventOutbox / NexiAttendanceHealth | SELECT/INSERT/UPDATE, CAS/recovery/outbox; invoker guards require underlying table reads/locks; permanence guards prohibit deletion/truncation. |
| NexiIngressScope | SELECT/INSERT/UPDATE for capacities, sequence and revision; locking SELECT FOR UPDATE also requires UPDATE privilege. |
| NexiIngressLane | SELECT/INSERT/UPDATE; DELETE only for existing empty-lane retention, still fenced by permanent-prefix guards. |
| NexiIngressJournal | SELECT/INSERT/UPDATE for admission, state and retention projection; no DELETE/TRUNCATE. Original proof fields remain trigger-protected. |
| NexiIngressEffectLane / NexiIngressEffect | SELECT/INSERT/UPDATE for secondary admission, leases, results and retention projection; no blanket DELETE. |
| NexiIngressContactCache | SELECT/INSERT/UPDATE/DELETE for cache upsert and expiry. |
| NexiIngressOwnerRoot / NexiIngressOwnerGeneration | SELECT/INSERT/UPDATE only; full-state receipt plus monotonic revision, approval and registration guards. |
| NexiIngressOwnerSource / NexiIngressOwnerDelivery | SELECT/INSERT only, permanent evidence and single-use link; no UPDATE/DELETE/TRUNCATE. |
| `_prisma_migrations` | Migration runner only; runtime needs no ledger access. Read/admin ledger operations must match the approved Prisma runner. |

Only two autoincrement sequences are declared by the inspected PostgreSQL model
sources: RuntimeConfig ID and NexiGroupEventOutbox ID. SQL sources use SERIAL and
BIGSERIAL respectively. Catalog-derived names/ownership/default dependencies are
required before named `GRANT USAGE ON SEQUENCE`; do not guess their names or grant
all sequences. Runtime requires neither `setval`/sequence UPDATE nor blanket
sequence SELECT for ordinary inserts. Owner generation UUIDs and counters require
no additional sequence grants. Client CUID/UUID values do not imply database UUID
extension requirements. Inspect actual defaults: source `@default` is not catalog proof.

Baseline attendance trigger functions are invoker functions:
`nexi_attendance_permanent`, `nexi_attendance_preparation_guard`,
`nexi_attendance_outbox_guard`, `nexi_attendance_canonical_version_immutable`,
`nexi_attendance_authority_guard`. Resolve exact installed versions and wiring from
catalogs; later migrations replace some definitions. The new migration has four
invoker functions and one SECURITY DEFINER function:
`nexi_ingress_owner_receipt_guard()`. Its owner, private schema, receipt-key table
and pgcrypto extension must be `nexi_evolution_guard_owner`; runtime has no
membership, private schema/column/table access or direct verifier EXECUTE.
Trusted-extension members can belong to PostgreSQL's bootstrap superuser; do not
give runtime schema USAGE or attempt to transfer/revoke those objects through
an owner that does not control them. pgcrypto elsewhere is a stop requiring a
separate extension plan, never an automatic relocation or drop.

## Prepared files and role boundaries

`ops/s12-evolution-catalog.sql` is an unexecuted read-only PostgreSQL 18 metadata
capture. It includes all non-system schemas, relation and column ACLs, defaults
(hashes/dependencies), sequences, FKs/cascades, indexes, functions/owners/ACLs,
trigger wiring, extensions, RLS, role graph, parameter ACLs, safe role settings,
consumer connection counts and Prisma ledger. It never reads the receipt key or
application rows. Record its output as restricted evidence and obtain its hash.

`ops/s12-evolution-privileges.sql.in` is deliberately gated with `\quit 3` before
any SQL and contains an unresolved database-OID token. It is a review worksheet,
not a production-ready script. It prepares four separate roles, all initially
NOLOGIN: schema owner, guard owner, migration login identity and runtime login
identity. Only migrator gets explicit SET membership of owners; INHERIT and ADMIN
are false. Runtime gets no membership. Production credential provisioning and
LOGIN activation are separate secret-manager operations.

The migration guard owner temporarily needs database CREATE (trusted extension
and private schema), public schema CREATE (new tables/functions), REFERENCES on
Scope/Lane/Journal and TRIGGER on Lane/Journal. Revoke these after migration.
Creating its four tables does not require transferring the existing postgres-owned
application tables. Existing ownership separation, if required, must use named
object transfers after catalog review; never `REASSIGN OWNED BY postgres`.

The worksheet supplies only the receive-protocol runtime delta. It does not
pretend to complete the baseline ORM grant matrix. Defaults revoke future PUBLIC
function EXECUTE globally for each actual creator and provide no automatic runtime
table/sequence grants. Existing objects and defaults belonging to other creators
need separate handling. A per-schema default REVOKE cannot remove a global default.
See [PostgreSQL 18 default privilege rules](https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html).

The role membership plan uses explicit ADMIN/INHERIT/SET options; a NOINHERIT
attribute alone does not prove the absence of reachable owner privileges. See
[PostgreSQL 18 GRANT](https://www.postgresql.org/docs/18/sql-grant.html).
Trigger creation requires TRIGGER on the table and EXECUTE on its function;
runtime application code has no direct trigger-function API to grant. See
[PostgreSQL 18 CREATE TRIGGER](https://www.postgresql.org/docs/18/sql-createtrigger.html).
Trusted extension ownership is documented in
[PostgreSQL 18 CREATE EXTENSION](https://www.postgresql.org/docs/18/sql-createextension.html).

## Mandatory review gates before any operational proposal

1. Reconcile immutable artifact provenance and obtain deployed schema/model bytes;
   capture final-base scripts and staged migrations. Match exact migration file
   byte checksums with `_prisma_migrations`, including failures/rollbacks; a latest
   name is insufficient. LF-normalized source hashes are not a substitute for
   the bytes Prisma recorded. The S8 manifest omits the new owner migration.
2. Capture complete catalogs with a separately authorized read-only operation;
   confirm database OID/schema, every consumer, owners, effective ACLs including
   PUBLIC/columns, memberships, defaults, parameters, RLS and extension location.
3. Resolve the final deployed module/table/column/function/sequence matrix,
   including dynamic delegates, aliases, nested writes/cascades and pruning.
   Review shared-consumer impact before PUBLIC CREATE/TEMP or function ACL changes.
   Produce explicit named grants and any necessary owner transfers.
4. Independently review a derivative of the gated SQL, pinned catalog hash and
   exact candidate/image. Keep runtime unable to own/alter objects, change roles,
   bypass RLS/triggers, use server file/program roles, create/temp schemas or call
   accessible SECURITY DEFINER code. No guard/HMAC weakening is an acceptable fix.
5. In a separately approved migration job, authenticate as migrator and prove
   `current_user=nexi_evolution_guard_owner` on every DDL/ledger connection.
   Direct superuser execution fails the migration's owner precheck. Verify the
   actual Prisma runner's role/URI-option propagation; do not assume it works.
   Do not manually mark a migration applied or replay the whole history.
6. Provision an independent 32-byte receipt secret through an audited channel,
   storing exactly the same bytes in the provider secret manager and private
   `receipt_key` row. No secret in code, command line, logs, chat or deliverables;
   no SQL signing oracle. Keep APP private/receipt keys out of Evolution.
7. After a separately approved migration, verify exact owners/function source,
   safe search path, private ACLs, extension members, 16 expected triggers and
   required unique indexes using `schemaGuard()`'s contract. Revoke temporary
   migration capabilities and recapture metadata. Prepared SQL has not been run.
8. Complete baseline grants and provision separate runtime credentials in
   `DATABASE_CONNECTION_URI`; keep migration/admin credentials out of runtime.
   A fresh origin pool must use identical session/effective runtime identity,
   public-only effective search path and no temp namespace. No elevated reachable
   memberships, database CREATE/TEMP, schema CREATE, object ownership, dangerous
   parameter SET/ALTER SYSTEM or callable non-system SECURITY DEFINER routines.
   Inspect parameter defaults/ACLs; setting origin once is insufficient.
9. Only after separate authorization deploy the reviewed image with feature
   disabled, recreate pools and prove all catalog/credential gates through the
   actual connections. Activation and the official owner flow require their own
   approval. Never process legacy journals or manufacture a witness to validate
   this preparation. Preserve uncertain work and permanent evidence on rollback.

This package advances the static preparation. It does not certify a complete
production grant matrix, verified deployed schema, working Prisma migration role
propagation or operational readiness. Those gaps are explicit blockers.
