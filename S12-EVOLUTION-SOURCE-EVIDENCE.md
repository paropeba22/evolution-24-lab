# S12 Evolution source evidence and remaining operational gates

Prepared 2026-10-26. The new Git evidence closes the historical input-attribution
gap in [the closure supplement](S12-EVOLUTION-CLOSURE.md). It records source
evidence only. Deployment readiness remains **false**.

The inspected candidate is `6c2703916035e2a16990883ab0764cd3fd797842`, tree
`c29fc0e89b0936f1b5774263b5cf1168379babc7`. The upstream is
`e273b904d53f5726970fd6a244ed9caa61dfeb9a`, tree
`7dd4410526782b0349b98b4eb700721dec98adbf`. Baseline overlay attribution uses
`f248f1ede50ec2d5519cef0ba4c391a49d6124b4`. These are resolved Git objects,
not revision names printed without checking their inputs.

## Evidence collected from local immutable objects

`ops/s12-reconcile-git-evidence.ps1` was used solely for static extraction and
hashing. It verifies full commit identities and each consumed blob's Git SHA-1
over its original bytes, then records raw SHA-256 separately from LF text SHA-256.
Git stdout is read as bytes; Windows checkout line endings and shell decoding
cannot replace the migration bytes being hashed. No application or schema patcher
is executed. No assembled schema is written or passed to Prisma.

The resulting `ops/s12-evolution-git-evidence.json` pins the exact schema fragments,
schema patchers, Dockerfile, config/start files, privilege contract and worksheets,
upstream deploy scripts/package lock, and full PostgreSQL migration input tree.
The script evaluates the previously documented schema text edits using those
immutable inputs. This establishes source attribution for that derivation; it
does not establish complete patcher/build equivalence or final image bytes.

| Derived or recorded source contract | SHA-256 |
| --- | --- |
| Baseline PostgreSQL schema, LF, equal to reported runtime schema hash | `145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f` |
| Candidate PostgreSQL schema, LF | `403b508bf0da6ceccb461b2b61837da1c450d8f36008acdee75f47018cc14463` |
| Candidate config, original Git bytes | `9615adcd624567b61043880dac5ee19441a7c0b2760057c70057b4a7fec99904` |
| Candidate start script, original Git bytes | `ed3b5a18fcf02f6da4a3edb53b8f70e5561b633a7092f4c7943b4a329eba5e90` |
| Owner-generation migration, original Git bytes | `e17a49cd4f395d79cc370679c9512f59184233fd19caa985b532b425f9329d57` |
| PostgreSQL migration lock, original Git bytes | `0b31557132059fe8acfa113635faaf57221a983fcc90ef2221bc35ca5308fa70` |

The inventory contains **71 migration.sql files plus migration_lock.toml**:
59 pinned upstream migrations and 12 overlay migrations. Every overlay migration
directory is checked against its explicit Dockerfile COPY; upstream/overlay path
collisions stop the extraction. Each record includes provider path, expected
staging path, origin commit, blob, byte length and both hash formats. This fills
the owner-generation omission in the older S8 source manifest. It is not an
instruction to deploy the full history. Neither source hash format is accepted
as a deployed Prisma ledger checksum without actual artifact-byte comparison.

The pinned upstream package lock records Prisma, client, engines and PostgreSQL
adapter at **7.8.0**. These are source dependency versions. The final image
inherits its maintenance package/scripts/dependencies from the separate final
base; those installed versions and bytes remain unverified. The source deploy
script stages `postgresql-migrations` as `prisma/migrations`, matching the config
and wrapper explanation. No claim is made about the actual staging directory.

## Privilege boundary

The 54 candidate model names match the 54 named relations in the source privilege
contract exactly. The existing operation classifications and named grant
proposals are pinned by blob; this work adds their source identity and coverage
evidence, without claiming an independent review of the proposed operations.

Keep unconditional core SELECT/DELETE for Rabbitmq, Nats, Sqs, Websocket, Typebot
and IntegrationSession. Their optional INSERT/UPDATE additions still require
confirmed deployed consumers. Profiles are additive per operation; disabling an
integration cannot remove those explicit core cleanup/read requirements.
Sequence USAGE remains limited to the catalog-confirmed dependencies of
RuntimeConfig.id and NexiGroupEventOutbox.id. The two actual sequence names are
still unknown. No wildcard sequence/function grant, runtime ownership, private
key access, trigger bypass or runtime ledger access is justified.

The coordinator supplied a fresh read-only observation at 2026-10-26 03:34 UTC:
Evolution still authenticates as postgres with LOGIN, SUPERUSER, CREATEDB,
CREATEROLE, REPLICATION and BYPASSRLS. This identity fails the owner-generation
contract. The restricted identities/defaults remain a prepared proposal; no
fresh restricted connection or enabled-profile/catalog evidence exists here.
Both SQL worksheets retain their initial `\quit 3` gates.

## Exact operational gates still blocked

| Gate | Missing evidence |
| --- | --- |
| Running artifact provenance | Typed immutable manifest/config or verified build attestation and relevant file/bundle bytes linking the image to source; origin of the filtered GIT_SHA setting. |
| Prisma maintenance artifact | Final package/deploy scripts, exact installed engine/client versions, provider and staged file bytes/lock, complete ledger rows with checksums and failure/rollback status. |
| Minimum runtime privileges | Exact database OID; per-name relations, columns, ACLs, owners, dependencies, routines/triggers/indexes, parameter/default catalogs, deployed profiles and other consumers. |
| Restricted maintenance/runtime identities | Separately authorized provisioning and fresh direct connection readback; actual Prisma connection behavior under the reviewed owner default; post-migration catalogs. |

At 2026-10-26 03:33 UTC the coordinator still observed service 1/1 at
`ghcr.io/paropeba22/nexi-evolution-s12-dispatch-bound-f248f1e@sha256:37bec98093e3a83b20cee3eb249379e325651c8cdc68bcf775f633515e620cf0`.
The reported OCI revision remains f248 and the container GIT_SHA remains b206.
There is no verified link from either metadata field to image content here.
The equal baseline schema inputs cannot distinguish those application revisions.
The operational artifact gate therefore remains specifically **blocked**.

No production query/action was performed by this work. No test, build,
compilation, dependency installation, Docker command, database, migration,
role/secret change, deploy or local service was run. The only executed recipe
read local Git objects and wrote evidence metadata. No final review of this delta
was performed; the coordinating task owns independent review.
