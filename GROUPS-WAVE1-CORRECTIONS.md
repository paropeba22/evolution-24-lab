# Wave 1 correction evidence

Correction starts at `c04855465d9e93596f248a73e4e9f8a731053f84`, without amending the accepted Wave 1 commit. APP companion starts at `dd8852494edda7d8a94f6c1bb3d51d0b65f454a7`. No push/deploy/live WhatsApp or product expansion.

## Strict self-review

| Finding | Original reproduction | Correction | Evidence/result |
| --- | --- | --- | --- |
| F1 | Actual pinned chats derivation emits participant contact from Group message. | Source stops generic contact/message derivation; provenance marker and actual provider contact sinks filter before lookup/log/dispatch/upsert. | Actual derivation + contact spies pass; zero generic effects, direct PN/LID unchanged. |
| F2 | Actual accepted receive function receipts before outbox admission. | Outer Signal transaction: decrypt → await canonical SQL → key commit → receipt. Admission failure skips fallback ACK/NACK and suspends socket without automatic reconnect/credential deletion. | Actual rc13 key transaction + patched receive pass DB unavailable, pre-enqueue failure, post-enqueue process death, offline live replay and stable UUID. |
| F3 | Accepted helper misses chat, arrays, normalized unknown suffix. | One validator at route/parser, every createJid result, socket/native chatModify and relay; all generic Group controls denied. Only signed control gets scoped metadata read capability. | Nested/array/unknown suffix/multipart/chatModify/send tests pass, with direct/unmanaged and signed discovery controls. Existing bot/Chatwoot tests pass. |
| F4 | Accepted catalog completion erases intervening invalidation. | Request captures instance/session/generation/revision; completion compares current identity and CAS revision before write. APP discards superseded snapshots before members/name. | Deterministic invalidation/session/instance/disable races pass; failed fetch never deletes members. APP unit passes, Rails races defined. |
| F5 | Accepted protocol target-ID-only delete acquires canonical projection. | Authenticated author must match explicit target participant/alias or own-key source; fromMe verified against credentials. No inferred admin privilege. APP verifies target scope or evidence-bearing tombstone. | Forged/wrong-room/foreign/unproved-admin/fromMe protocol tests pass; APP accepted-versus-corrected foreign-target unit passes. |
| F6 | Accepted enqueue namespaces session, allowing two incompatible sources. | Stable room/external source key with fingerprint rejects session/generation/direction/content conflicts; display name is not identity. APP persists immutable source scope. | Same replay idempotent; incompatible sessions/direction rejected; rooms independent. Service tests pass, APP DB specs defined. |
| F7 | Accepted APP trigger allows alias/fingerprint/time mutation. | Companion APP freezes every source/dedupe key and scoped tombstones; content-only erasure. | APP accepted/corrected source assertions pass, negative PostgreSQL specs defined and unrun. |
| F8 | Accepted APP channel-first path creates inverse Account FK lock edge. | Companion Account-first consistent lock order; no locks held across control network fetch. | APP source assertions pass; actual independent-connection PostgreSQL test defined and unrun. |
| F9 | Accepted failed attempt 100 still retains queued content; selected row claims after new backoff. | 12 attempts or 24 hours; visible quarantine, global sweep clears payload, retains opaque identities. Atomic due/lease/age/attempt claims and unexpired token ACK/retry. No workers Set. | Independently compiled workers pass contention, backoff, death/lease and stale ACK; real two-connection PostgreSQL gate defined/skipped. |
| F10 | Actual accepted call callback logs raw Group packet and dispatches. | Technical provenance guards before raw call/contact events; socket root logger, receive/decrypt packet and nested privacy scopes emit fixed codes. | Accepted/current raw callback and logger assertions pass; no Group content/identity/packet in logs, direct logs preserved. |
| F11 | Accepted MySQL has no positive-generation parity. | Equal correction constraints for generation/revision/attempts/states; psql_bouncer mapping unchanged. | Normalized migration parity and negative assertions pass; Prisma validates PostgreSQL/MySQL/psql_bouncer. Real database tests remain gates. |

The accepted-commit reproduction harness loads that helper and reconstructs its pinned patches in a temporary directory. It executes original F1/F2/F3/F4/F5/F6/F9/F10 behavior and checks original F11 SQL. APP independently executes the old `redact!` versus corrected code and checks old/new F7/F8 source. Corrected tests execute changed functions; source assertions are explicitly distinguished from real database execution.

## Durability and terminal semantics

Baileys rc13 nested key transactions reuse the outer transaction context, so ratchet/sender-key writes cannot commit before canonical SQL. Receipt and ACK happen afterward. If SQL fails, canonical capture was not claimed: key writes roll back and socket ends with the fixed suspension code. The special close branch stores a safe 503 state and avoids native reconnect/logout; ordinary direct 408/reconnect branches stay unchanged. Explicit operator restore or process restart after storage recovery is required; no infinite reconnect loop is added.

If SQL commits and process dies before Signal key commit or receipt, live replay meets the same stable source key. If Signal keys commit, canonical SQL has already committed. Histories/public event copies cannot impersonate the raw callback. Server-queued live deliveries with offline flag can replay, but indefinite server retention and history recovery are not promised. Unsupported/malformed/unallowlisted traffic does not gain canonical eligibility.

The global retention sweep runs every 15 seconds even for unloaded instances, independently of webhook availability. When the service is stopped, cleanup resumes on restart; payload retention requires that runtime worker to run. Quarantined/rejected/delivered rows clear payload while immutable opaque sourceKey, fingerprint and eventId prevent resurrection. Independent worker modules use shared atomic database predicates, not local coordination. APP encrypted durable control intents similarly record remote failures and generation-fenced retries; immediate local revoke remains authoritative. Local-left update and enqueue share a SQL transaction and checked CAS.

## Local verification and runtime gates

Full existing and new Node suites: 139 tests, 133 pass, 6 skipped, zero failures. This includes accepted financial/direct/native retry, trusted identity, patch structure/syntax and three Prisma provider validations. Six skips: three actual compiled-image tests, PostgreSQL integration, Redis integration and existing runtime generated-model case without ChatwootInbox. No dependencies were installed.

`groups-postgresql.integration.test.cjs` is opt-in: use only a disposable `NEXI_GROUPS_PG_TEST_URL` and an existing pg driver (optional `NEXI_GROUPS_PG_DRIVER_PATH`). It creates/deletes its own random schema, applies both migrations, tests negative constraints and real separate connections for claims, lease death, backoff and ACK race. It never reads the production database environment variable. PostgreSQL/MySQL migration execution, actual provider image/runtime model assertions, APP supported-bundle Rails tests, Redis and real transport verification remain pre-promotion gates; none was called live here.

## Correction file manifest

```text
Dockerfile
GROUPS-WAVE1-CORRECTIONS.md
GROUPS-WAVE1.md
groups-postgresql.integration.test.cjs
groups-wave1.test.cjs
nexi-groups.cjs
patch-groups-source.mjs
prisma/mysql-migrations/20261002000001_harden_groups_wave1/migration.sql
prisma/postgresql-migrations/20261002000001_harden_groups_wave1/migration.sql
```
