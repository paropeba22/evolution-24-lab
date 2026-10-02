# Wave 1 second correction — N1–N6

Starting Evolution HEAD: `7e7bc04ac397bc92f1cd0ed32833474e16b58410`.
Starting APP HEAD: `7b698c751c6a1658199325e8b131a6d8be5965e9`.
Both verified clean on `feature/nexi-groups-v1-wave1`. Prior history is preserved.
No push/deploy/live WhatsApp action/dependency installation. Pinned upstream and Baileys rc13 remain unchanged.

## Delta self-review

| Finding | Original reproduction | Correction | New regression / result | Runtime-only gate |
| --- | --- | --- | --- | --- |
| N1 HIGH | Actual preceding transformed callback from A ends mutable replacement B; special permanent close has no automatic health-aware recovery. | Exact socket/auth ownership; DB owner token and status-write CAS; recoverable connecting/503 reason; bounded admission-write probe and controlled reconnect including restart. | Socket A/B, transient and sustained storage outage, direct resume, canonical replay, delayed A status write, uncertain registration outcome, old/new persisted reason and startup unavailable DB. Actual pre-ACK receive/key transaction harness still proves zero ACK on failure. Pass. | Real write probe, independent DB owner CAS, native outage/restart/replay. |
| N2 HIGH | Preceding helper flags realistic direct message key ID; actual bot dispatch is suppressed. | Explicit destination allowlist; message IDs/source IDs are not normalized. Chatwoot sender identifiers mapped only at its operation boundary; post-normalization and native relay/control guards retained. | Actual transformed dispatch fixtures include remoteJid and realistic key.id; hexadecimal/numeric/UUID, PIX/boleto/copyCode, PN/LID and all managed target shapes. Pass. | Compiled provider/native transport gate. |
| N3 MEDIUM | Raw notification for unenabled room leaves stale catalog cache fresh. | Authenticated current-session invalidation precedes room eligibility and ACK; unprojectable Group-server notifications advance catalog without fabricating an APP event. Catalog stale flag forces refetch and request/session/revision CAS rejects superseded completion. | Original behavior reproduced; OLD → notification → NEW, A/B completion discard, no enabled room, missing canonical ID/time, session replacement and failed-fetch preservation. Companion real service harness passes. | Real notification replay and DB transaction race. |
| N4 MEDIUM | Preceding source key permanently conflicts on external ID reused in valid new session. | Source hash includes binding epoch and registered session, scoped room/event/external ID; APP namespaced lookup/index/target and authority before receipt replay. Legacy UUIDs/fingerprints retained with real namespace or conservative migration fence. | A/X, retired A reject, B/X, B replay, incompatible sender/direction/content, room separation, historical UUID preservation and opaque legacy fence. Pass. | Apply migrations on existing data in PG/MySQL; APP DB specs. |
| N5 MEDIUM | Actual preceding offline processor leaks shared Signal identifiers; pinned libsignal console emits session objects outside logger filtering. | Both online/offline processors run shared Signal/key transactions and receive catches in packet scope; child logger protected; pinned console sites route through async scope; unknown raw receive boundary uses safe diagnostic path. | Actual Signal identity log/key transaction error and patched session-record console; online/offline Group privacy, failed decrypt, ambiguous stanza and Group-server packet; direct PN/LID diagnostics retained. Pass. | Build copies/asserts patched libsignal/Baileys and run isolated native offline receive. |
| N6 MEDIUM | Companion actual historical reconciliation + Administration dispatch raises Integer.success?. Lost CAS could report remote success locally. | Typed frozen Result; exact unexpired lease completion/retry count; current authority recheck after HTTP under existing lock order. Existing compensation remains. | Companion production call graph tests all specified outcomes, late/expired lease, generation, local disable and enable compensation. Pass; Rails DB specs added. | Supported Rails/PostgreSQL lease/authority concurrency. |

Tests reconstruct immutable old correction sources to reproduce N1/N2/N3/N4/N5. APP reconstructs old N6 class in its actual dispatch call graph. Current tests execute production functions and transformed pinned source; fake persistence tests do not claim real database contention.

## Socket suspension and recovery

Durability remains decrypt → awaited canonical SQL → Signal key commit → receipt. Failed admission rolls back key writes, emits no receipt/ACK/NACK and ends only the exact originating socket. Socket callback captures that socket's credentials; mutable replacement auth cannot restamp old traffic. Stale callbacks, storage completions, recovery attempts and connection events cannot terminate or overwrite a replacement socket.

The special condition persists `connectionStatus=connecting`, 503 and fixed `nexi_groups_admission_suspended`, never manual/permanent close semantics. DB failure writing that reason still leaves the current runtime owner suspended and recoverable. Startup accepts the preceding correction's close reason as recoverable. Loader carries the fixed suspension hint before a second storage read, so unavailable startup DB does not discard recovery ownership.

Existing 15-second tick checks a due owner only. Delay starts at 5 seconds and grows exponentially to 300 seconds, with no immediate reconnect loop. Health runs an actual outbox INSERT and control CAS in a transaction deliberately rolled back; it commits no content/probe/dedupe row. Read-only health cannot enable receive. Only proven storage health plus current physical socket and registered DB owner can permit one reconnect. A failed reconnect is bounded again. An uncertain owner-registration response may be adopted only when its token was proposed by that exact prior owner; a foreign token cannot be adopted. Constructor failure after registration retains a recoverable owner placeholder.

Connection status suspension writes atomically predicate `Instance.nexiGroupsSocketOwner`, so a delayed old write cannot set the replacement's status. This is not a distributed platform ownership redesign: the existing instance host/monitor model is retained. Ordinary unmanaged/direct 408/reconnect/logout branches are unchanged. Direct PN/LID traffic resumes with the recovered socket; no guarantee of indefinite WhatsApp server retention is added.

## Namespace migration

Apply `20261002000002_namespace_groups_source` after both prior Groups provider migrations. Prisma adds sourceSession/sourceGeneration/legacyGeneration and Instance.nexiGroupsSocketOwner consistently in PostgreSQL, MySQL and psql_bouncer; the latter still uses PostgreSQL migrations/bundle mapping.

Canonical source is binding generation + authenticated registered session + room/event/external identity. A source in the same namespace with incompatible sender/direction/content fails closed with a fixed diagnostic; valid replay uses the same event UUID. An authenticated replacement can reuse the external ID. Old session and stale binding fail authority before enqueue, not after conflict lookup. APP target/tombstone namespace cannot redact earlier-session rows.

For legacy outbox entries with canonical payload, migrate true session/epoch without altering UUID, source key or fingerprint. Cleared legacy payload has no recoverable source authority: retain its tombstone with current monotonic control epoch as a fence. Same/earlier epochs remain closed; a later authenticated epoch may reuse the ID. Missing control receives INT_MAX floor and requires isolated data preflight rather than invented history. New constraints explicitly reject missing/partial namespace, nonpositive generation/fence and invalid session length. PG/MySQL constraint parity is asserted negatively; existing positive-generation/retention constraints remain.

## Privacy and dispatch

Only semantic destinations enter normalization. `id` and `source_id` are message identity, even when numeric-looking. Within destination descriptors, a literal explicit Group JID in id is denied, but ID digits never enter normalization. Actual normalized send/relay/chatModify destinations are validated again. Raw body/PIX/boleto text is not a destination.

Authenticated raw Group metadata/membership invalidates catalog independently from enabled-room canonical revision. Failure cannot fabricate empty membership or deletion. Unknown room or missing canonical ID/time does not excuse storing an outstanding old fetch as fresh.

Online buffered and offline processors establish the same AsyncLocalStorage privacy scope before shared Signal/key-store diagnostics and catches. Narrow patches route all executable libsignal console sites through that scope without replacing process-wide console. Each shared per-device Signal queue job captures its own scope at enqueue: a Group job behind a direct job cannot inherit direct diagnostic permissions, and a direct job behind a Group job retains its diagnostics. Both interleavings execute the actual patched queue in tests. Technical Group server namespace and ambiguous raw receive boundaries use fixed diagnostic codes; privacy fallback does not confer admission authority. Image copies and runtime assertions require patched libsignal as well as Baileys.

## Validation and runtime gates

```text
node --test *.test.cjs
node --check nexi-groups.cjs
node --check patch-groups-source.mjs
git diff --check
```

Full lightweight Groups/direct/identity/financial/source run: 147 tests, 141 pass, six runtime skips, zero failures. Three Prisma schemas validate with already-installed dependencies. Accepted recipient proof, PIX, boleto, outcome_unknown and native retry suppression remain covered. Tests use no live WhatsApp. The real PostgreSQL opt-in test now seeds retained/cleared legacy rows before migration, checks namespace constraints and socket-owner CAS on independent connections, plus prior outbox claims/death/backoff/ACK races.

Six existing runtime skips are explicit: three compiled-image gates; PostgreSQL integration without disposable test DB; Redis integration without test server; runtime generated-model case without built ChatwootInbox client. No Docker/provider image build, database migration application or Redis execution is represented as complete. Supported APP Rails/RSpec/encryption/PG and isolated native receive/recovery remain companion runtime gates. Existing APP four unrelated baseline-equivalent failures remain unchanged.

The source audit checked for new BLOCKER/HIGH/MEDIUM issues introduced by this delta. Additional owner-status CAS, uncertain-registration recovery, unprojectable-notification invalidation and Signal console diagnostics were corrected within N1/N3/N5 and given executable regression evidence. Account-first locks, pre-ACK storage, Group side-event isolation, target denial, redaction/source immutability, bounded outbox quarantine and provider parity remain covered.

## Evolution file manifest

```text
Dockerfile
GROUPS-WAVE1-CORRECTIONS-2.md
GROUPS-WAVE1.md
assert-groups-runtime.mjs
groups-postgresql.integration.test.cjs
groups-wave1.test.cjs
nexi-groups.cjs
patch-groups-source.mjs
prisma/mysql-migrations/20261002000002_namespace_groups_source/migration.sql
prisma/postgresql-migrations/20261002000002_namespace_groups_source/migration.sql
```
