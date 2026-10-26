# S12 Evolution: source matrix and Prisma owner contract closure

Prepared only, 2026-10-25. This supplement supersedes the unresolved source-level
findings in the initial privilege report where expressly stated below. No tests,
builds, compilers, SQL execution, service/container/database execution, package
installation or production actions occurred in this task. The new operational
facts were supplied directly by Luna; this task did not collect them.

## Concrete changes

The privilege preparation now sets the migrator's database-specific login
default to `role=nexi_evolution_guard_owner`, with `search_path=public` and
`session_replication_role=origin`. PostgreSQL applies these defaults when each
direct backend authenticates as `nexi_evolution_migrator`. Thus Prisma's separate
connections receive the same effective owner; no one-client SET ROLE or
unverified URI/PGOPTIONS propagation is used. The owner remains NOLOGIN; migrator
membership has SET true, INHERIT false and ADMIN false. Runtime has no membership.

The new `ops/s12-evolution-migration-preflight.sql` checks a fresh connection's
session/effective identities before any SET ROLE, the exact database OID/version,
login defaults and membership options, origin/path/no-temp conditions, baseline
absence of candidate tables/private schema/pgcrypto, ledger failure state and the
required temporary DDL capabilities. It is read-only and was not executed.
The main provisioning worksheet and named grant proposals retain their initial
`\quit 3` gates. This is a corrected preparation contract, not evidence that new
roles or defaults already exist in production.

This mechanism is supported by PostgreSQL's own
[SET ROLE contract](https://www.postgresql.org/docs/18/sql-set-role.html): RESET ROLE
returns to the connection-time role specified by role/database defaults. Defaults
are server-side login state, not a Prisma ORM pool callback. Startup options that
override role, RESET ROLE NONE, a different login, or transaction poolers invalidate
the reviewed maintenance contract. The final maintenance artifact must reject
those paths. A fresh-connection readback after separately authorized provisioning
is still an operational gate; this task cannot truthfully certify a role that does
not yet exist.

No defect in `prisma.config.ts` or the provider wrapper was demonstrated; neither
was changed. No runtime/proof/HMAC/approval/FIFO/dedup behavior was changed.

## Schema and wrapper hashes reconciled

The schema hash supplied by Luna is reproduced exactly by statically evaluating
only the source schema text edits from upstream
`e273b904d53f5726970fd6a244ed9caa61dfeb9a` plus overlay
`f248f1ede50ec2d5519cef0ba4c391a49d6124b4`: inbox field insertion, Instance group
relations, exact group model template, attendance fragment and ingress fragment.
Every edit uses the exact pinned anchor/template; no guessed models or Prisma
generation are involved. Text is explicitly LF, matching the actual patchers.

| Contract | SHA-256 |
| --- | --- |
| Runtime baseline schema, independently derived and equal to supplied runtime hash | `145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f` |
| Candidate schema from the approved protocol source, including four owner models | `403b508bf0da6ceccb461b2b61837da1c450d8f36008acdee75f47018cc14463` |
| Config, LF, identical at b206/f248/candidate | `9615adcd624567b61043880dac5ee19441a7c0b2760057c70057b4a7fec99904` |
| Pinned upstream wrapper, LF, equal to supplied runtime wrapper hash | `e0a66767b5a349b74d70584204ade30f8debfc760253070a2507574621eee1f8` |
| Runtime start script, LF, equal to candidate and supplied runtime hash | `ed3b5a18fcf02f6da4a3edb53b8f70e5561b633a7092f4c7943b4a329eba5e90` |

The initial raw-wrapper mismatch was CRLF versus LF, not evidence of different
wrapper logic. `ops/s12-evolution-schema-reconciliation.json` preserves all
compared variants. The repeatable static recipe is
`ops/s12-reconcile-schema-static.ps1`; it emits observed text hash evidence only.
It invokes no application, patcher, Prisma, compiler or DB.

These reported equalities concern schema/config/wrapper/start **content**. The
baseline schema inputs are identical between b206 and f248; schema equality does
not distinguish their application revisions. The candidate schema hash is an
expected text contract, not a hash of a newly built/deployed candidate image.

Revision attribution is not established by this recipe. The historical report
above named pinned revisions, but the previous script printed those constants
without validating the supplied directories against Git commits/blobs. The saved
JSON now explicitly marks that historical provenance as unverified; its existing
output hashes are retained observations, not a newly reproduced result.
The corrected script snapshots each consumed input text once and records its
resolved root, relative path, decoded-text SHA-256 and CRLF-normalized LF SHA-256.
Hashes cover UTF-8 re-encoded text after `ReadAllText` encoding/BOM handling, not
original file bytes. Arbitrary directories can be compared, but no fixed revision
is attributed to them. Independent commit/blob comparison is required for source
attribution, and complete patcher/build/artifact provenance remains a separate
gate. Anchor matches and output hash equality alone cannot establish it. The
corrected recipe was not executed in this review correction; no tests were run.

`prisma.config.ts` reads `DATABASE_CONNECTION_URI`, selects the PostgreSQL schema,
and points to `prisma/migrations`. The matched wrapper maps psql_bouncer to
postgresql-migrations. The pinned upstream package deploy script stages the
provider tree into `prisma/migrations`; however, the final `package.json` deploy
script, deploy shell, complete migration tree/checksums and presence/content of
the staging tree have not yet been supplied. The existing source explanation
cannot establish those final-image facts. The matched runtime start script does
not migrate/generate, so runtime startup must stay separate from maintenance.

## Image metadata and supplied production catalog

Luna reports service/container image reference
`ghcr.io/paropeba22/nexi-evolution-s12-dispatch-bound-f248f1e@sha256:37bec98093e3a83b20cee3eb249379e325651c8cdc68bcf775f633515e620cf0`,
service desired/current 1/1, running container `c79a36b4fa3a`, update completed,
label revision `f248f1ede50ec2d5519cef0ba4c391a49d6124b4`, source label
`evolution-foundation/evolution-api`, version `homolog`, created
2026-10-24T18:40:55Z. Container `GIT_SHA` is still
`b206baaa0518ba881fade671942a693ca1c24188`.

The supplied “OCI image Id” repeats the registry digest. These fields are retained
as reported: Docker config-image IDs, manifests and indexes are distinct artifact
types and must not be conflated. A typed immutable manifest/config or verified
build attestation, plus the source of the filtered GIT_SHA setting (image versus
service override), is still needed to attribute that disagreement. Neither a tag,
label nor environment variable alone proves the complete application source.
No source label or GIT_SHA was rewritten merely to hide this disagreement.

The database report is PostgreSQL 18.6, database nexi, DB container `54efbfcadaba`.
It lists 51 ordinary tables, two sequences, 118 indexes and five routines, all
application objects owned by postgres; five routines are SECURITY INVOKER.
All table/sequence `relacl` and routine `proacl` values are NULL; no default ACLs
or SECURITY DEFINER routines were reported. Public is owned by pg_database_owner;
PUBLIC has schema USAGE, no schema CREATE, and database CONNECT/TEMP. Only
plpgsql is installed. Postgres is the only LOGIN and remains superuser with
CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS; three idle app connections use it.
This confirms the need for the prepared credential/privilege transition, not
existing least privilege. The counts are consistent with 50 baseline models plus
Prisma's ledger; counts alone do not prove the exact names or dependencies.

Only the latest applied migration name was supplied, ending in contact-cache
20261015000002. The owner-generation migration is absent. Full per-name ledger
checksums, failed/rolled-back rows, relation columns/FKs/cascades, sequence
dependencies, trigger/index definitions, routine signatures/source hashes and
parameter/default catalogs are still required for exact reconciliation.

## Completed source matrix and named grant proposals

`ops/s12-evolution-runtime-contract.json` classifies **all 54 source models** by
operation, with direct call locations and the resolved concrete bindings for
generic chatbot bot/settings/session/credential repositories and all seven event
controller names. Attendance/group aliases are traced explicitly; they are not
unioned blindly, which would overgrant UPDATE on immutable context/receipt rows.
The previous lexical-only inventory remains an input index, not the final matrix.

The matrix includes the full core API, session/auth state, message/contact/chat
storage, configuration, media, licensing, chatbot/event integrations, group
outbox/control, attendance, durable ingress and owner-generation records.
Prisma returning projections/predicates explain SELECT; nested connects do not
justify runtime REFERENCES. FK cascade operations do not require granting child
DELETE simply because a parent can be deleted. No TRUNCATE, DDL, object ownership,
TRIGGER, REFERENCES, MAINTAIN or grant options are proposed.

The companion `ops/s12-evolution-named-runtime-grants.sql.in` proposes privileges
per named table and module profile. It retains its own gate. This closes source
classification, not the deployment's minimum: enabled module profiles and actual
consumers must be confirmed before selecting grants for optional integrations.
Current superuser behavior is not accepted as evidence that every existing
privilege is needed.

For Rabbitmq, Nats, Sqs and Websocket, the relation's `core_api` privileges are
SELECT and DELETE: `monitor.service.ts:109` includes all four unconditionally,
and explicit cleanup calls at lines 215–217/220 require DELETE independently of
feature flags. These are direct calls, not inferred FK cascade requirements.
The additive `optional_profiles` entry reserves INSERT/UPDATE for confirmed
`event_integrations` consumers (`event.controller.ts:100` upsert); its get at
line 125 uses core SELECT. The named SQL separates the same operations. Selecting
core cannot omit those reads/deletes or select optional writes implicitly.
Both profile selection and catalog reconciliation remain behind the existing
fail-closed gates; `deployment_ready=false` and the initial `\quit 3` are retained.

The two sequence requirements are USAGE on the catalog-confirmed sequences
dependent on RuntimeConfig.id and NexiGroupEventOutbox.id, never UPDATE/setval.
Names remain unset in the contract because only sequence counts were supplied.
All ten known public trigger functions (five baseline and five candidate) are
classified as having no direct runtime EXECUTE requirement. The only candidate
SECURITY DEFINER verifier belongs to the protected NOLOGIN owner, with private
schema/key access withheld from runtime. The ledger and private key relation are
explicitly runtime-denied. No function or sequence wildcard grant is proposed.

## Exact external gates remaining

1. Typed immutable image manifest/config/build provenance and filtered GIT_SHA
   origin, or file/bundle attribution sufficient to explain the revision mismatch.
2. Final package/deploy script bytes, complete provider and staging migration
   file names/checksums/lock file, full ledger checksums/status, and exact Prisma
   engine/package versions. No whole-history migrate deploy until reconciled.
3. Per-name production catalog evidence listed above, the exact database OID,
   module configuration and external consumer scope; then select and review the
   named minimum grants and sequence identities. Aggregate counts cannot release
   a privilege gate.
4. A separately authorized provisioning/migration window and fresh direct
   connection identity readback. Current production cannot satisfy the prepared
   contract because the restricted roles do not exist. No local test or invented
   success result may substitute for that evidence.

The engineering delta fixes the owner propagation preparation and completes the
source access classification. The main `\quit 3` and `deployment_ready=false`
remain because the external evidence is incomplete. No GO for build/deploy or
production action is issued by this package; independent final review remains
the coordinating task's responsibility.
