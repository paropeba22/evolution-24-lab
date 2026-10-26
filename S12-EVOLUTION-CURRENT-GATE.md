# Current Evolution candidate gate — 2026-10-26

Compared exact candidate `a2ad9338c5901f10d001495ba357938915d28c79` with approved
ancestor `6c2703916035e2a16990883ab0764cd3fd797842`, using the existing worktree
and inventories. The ancestor relationship is confirmed; both inputs resolve to
immutable Git objects. The candidate was clean before this focused preparation.
Model/session metadata again confirms gpt-6.1-sol, effort high.

The delta preserves `ingress-models.prisma`, `prisma.config.ts`, the owner migration,
all functional ingress code, the 54-relation operation matrix, named grants and
owner/default-role provisioning. It adds source evidence and replaces the
inherited credential-logging deploy shell with the tracked literal-output shim.
The independent static review of a2ad found no actionable defect in that scope.
The two P2 findings against older snapshot 87046e7 were already fixed by
cc17215bd64adeae396bd81a839fbe290ec4d9b1 and
6c2703916035e2a16990883ab0764cd3fd797842. The current core/additive grants are
preserved, and the path-based schema recipe reports OBSERVED_CONTENT_ONLY with
revision_attribution_verified=false rather than fixed revision claims. Immutable
commit/blob attribution is provided by the separate Git evidence recipe.

## Source bytes and migration

The existing immutable-blob recipe was rerun for **a2ad**, reading Git objects
only. It invokes no patcher, application, Prisma, SQL, compiler, build or service.

| Source contract | Exact value |
| --- | --- |
| Candidate PostgreSQL schema text SHA-256 | `403b508bf0da6ceccb461b2b61837da1c450d8f36008acdee75f47018cc14463` |
| Reported running baseline schema SHA-256 | `145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f` |
| Owner migration path | `prisma/postgresql-migrations/20261025000000_nexi_ingress_owner_generations/migration.sql` |
| Owner migration Git blob | `064634227cbce330c70e6eeada4db6536e627d07` |
| Owner migration original Git bytes | 20040 bytes, SHA-256 `e17a49cd4f395d79cc370679c9512f59184233fd19caa985b532b425f9329d57` |
| Provider source inventory | 71 migration.sql files plus migration_lock.toml |

The four owner models and their receipt fields are in the candidate's actual
schema input fragment. The Dockerfile copies the owner migration into the
PostgreSQL provider tree before generation and copies that Prisma tree to the
final image. Config selects the PostgreSQL schema and staging path
`prisma/migrations`; the source wrapper/package explain provider-to-staging copy.
The SQL adds the four owner tables, private key schema/table, five guard functions
and sixteen triggers. No journal/lane backfill is introduced.

These are source/schema-input facts. No complete standalone provider schema is
committed in this overlay, and no new final image exists in this task. The last
supplied runtime schema is the baseline, with no owner-generation tables or
applied target migration. Source text derivation is not a claim that a patcher,
Prisma generation or operational migration ran successfully.

## Focused precondition correction

The previous preflight rejected failed migrations and an already recorded target,
but it could pass a ledger missing an older migration. A later migrate deploy
could then replay historical DDL before reaching the single approved target.
It also checked the valid guard-owner membership without rejecting extra edges.

The preflight now requires all four principals with safe attributes, both owners
NOLOGIN, the migrator LOGIN, exactly its two SET-only owner memberships and no
granted roles for runtime or owners. Runtime may remain NOLOGIN during maintenance
because runtime credential activation is separate. No privileges are added.

Its new include `ops/s12-evolution-baseline-ledger-contract.sql` requires an active
read-only migration session and exactly the 70 pre-target source migration names,
one non-rolled-back successful ledger row per name, positive applied step count,
and source-checksum equality. Missing, unknown, duplicate, unfinished or mismatched
active records fail. Rolled-back historical attempts remain untouched. The target
must still be absent. No SQL in either file was executed here.

The checksum list is generated from the existing raw Git blob inventory, not
Windows checkout line endings. Actual provider/staged bytes and ledger rows are
still required to accept those hashes operationally. A match to source expectations
alone cannot release the final-artifact or deployment gates.

## Final source role matrix

`ops/s12-evolution-principal-contract.json` complements the 54-relation operation
matrix with explicit runtime/migrator/schema-owner/guard-owner boundaries.

| Principal | Prepared authority |
| --- | --- |
| Runtime | CONNECT, public USAGE, named per-operation table grants and two catalog-confirmed sequence USAGE grants; no memberships, object ownership, DDL, ledger/key access or direct trigger EXECUTE. |
| Migrator | Separate short-lived credential; exactly SET=true, INHERIT=false, ADMIN=false membership of the two owners; owns no objects. Database-specific login defaults select guard owner/public/origin on every direct authenticated connection. |
| Schema owner | Permanently NOLOGIN, no memberships; only exact reviewed baseline owner transfers, if required. No blanket postgres ownership transfer. |
| Guard owner | Permanently NOLOGIN, no memberships; owns new generation objects, protected verifier/private key schema/table and extension. Temporary CREATE/REFERENCES/TRIGGER/ledger DML is revoked after verified maintenance. |

Core SELECT/DELETE on Rabbitmq/Nats/Sqs/Websocket/Typebot/IntegrationSession stays
unconditional; optional module writes are additive. Source/Delivery and immutable
context/receipt records still have no runtime UPDATE/DELETE. Sequence names remain
unresolved until exact dependency catalogs are supplied. Membership, owner,
PUBLIC/default/column ACL and dangerous-parameter checks remain mandatory through
the full storage guard before activation; the migration preflight is not a
replacement for that runtime guard.

The main worksheets still exit with `\quit 3`; deployment_ready remains false.
There is no GO while typed image/source provenance, final package/engine/provider
and staging bytes, complete per-object catalogs/ledger, consumer profiles and
fresh restricted connection readback remain missing. No wrapper or functional
ingress change is warranted by the current byte comparison.

No test, build, compilation, SQL, Prisma, Docker, application service, database,
production mutation, push or workflow dispatch was executed in this task.
