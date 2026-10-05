# NEXI Attendance Wave 1B — source review contract

Strict review corrections and versioned canonical authority are documented
in [ATTENDANCE-WAVE1B-CORRECTIONS.md](ATTENDANCE-WAVE1B-CORRECTIONS.md).

Source implementation only. Managed Attendance physical dispatch is disabled.
No deployment, dependency installation, project test, build or migration was
executed on Serra. EasyPanel is the build/runtime validation environment.

## Authority and baselines

Fresh checkout: `C:/Users/flavi/nexi-wave1b/evolution`.
Remote: `https://github.com/paropeba22/evolution-24-lab.git`.
Remote main and feature starting commit:
`334b9119030aec6c9241fd8fe878d03aceef83cc`.
Feature branch: `feature/nexi-attendance-wave1b-boundaries`.
Pinned upstream: `e273b904d53f5726970fd6a244ed9caa61dfeb9a`.
Pinned Baileys: `7.0.0-rc13`; pinned Prisma MariaDB adapter: `7.8.0`.
The damaged Windows repositories were neither reused nor repaired.

APP owns the business graph, execution, attempt, permanent external-ID
reservation, admission, release, sender lineage and delivery projection.
Evolution stores physical recovery evidence. Its local unique external-ID index
is a correlation constraint, not another reservation authority.

## Source trace and shipped boundaries

The Docker overlay applies Attendance after the accepted financial, trusted
Baileys, managed-retry and Groups source layers, before Prisma generation.
`patch-attendance-source.mjs` verifies exact anchors across the complete layer
before writing any file. Zero or multiple matches fail the build. Snapshots
allow adversarial anchor tests without mutating the build checkout.

Pinned boundaries:

- `whatsapp.baileys.service.ts`: configure the actual cloned financial socket
  config; track the lifecycle-owned socket; guard public raw-node sends.
- Baileys `Socket/index.js`: carry trusted WeakMap registration across its
  internal config clone. Attributes and serializable flags cannot create it.
- Baileys `socket.js`: verified public pairing/restoration evidence; lowest
  `sendNode` gate before binary encoding; exported raw-byte guard. The lexical
  handshake sender remains independent.
- `messages-recv.js`: bounded raw receipt append before `messages.update`
  buffering/consolidation; native retry suppression before message reconstruction
  enters the relay path.
- `messages-send.js`: check the completed regular/newsletter stanza ID and
  recipient, after construction, before the existing financial wire guard.
- Chatwoot receive, history import, import-database source-ID writer and READ:
  server-owned classification hooks, retaining ordinary legacy behavior until
  the future APP-owned cutover. A durable Attendance preparation cannot use them.
- Voice-call structured-node sends: trusted socket identity check.
- Prisma repository: separate receipt client/pool and bounded driver operations.
- Router and tsup: independently APP-signed preparation route; external helper
  preserves WeakMap/AsyncLocalStorage identity across the compiled bundle.

`assert-attendance-runtime.mjs` inspects each actual shipped provider bundle,
runtime model and installed Baileys file. It asserts hook multiplicity, receipt
ordering, final ID checks, inherited config and dispatch denial. Docker applies
these checks to PostgreSQL, MySQL, cached psql_bouncer and the final image.
These assertions have been written; they have not run locally.

## Versioned contracts

Schema/protocol/writer version: **1**. Provider: `evolution-baileys`.
Audience: `nexi-attendance-app` for events/requests and
`nexi-attendance-evolution` for APP-signed context/preparation grants.
Exact key sets are enforced; unknown authority fields are rejected. Canonical
JSON sorts UTF-8 keys and accepts plain objects, arrays and safe integer/scalar
values. Events are bounded to 16 KiB; preparation content to 8 KiB.

Common provenance carries account/channel, immutable instance ID/lineage,
observed/original session, sender lineage/attestation reference, binding
generation, writer epoch/version and barrier state. Unresolved lineage fields
are nullable only for evidence; preparation requires existing APP authority.
Barrier states reuse `staged`, `fencing`, `active`, `pause_requested`, `paused`,
`retired`, with `unresolved` for absent authority.

Implemented event schemas:

| Contract | Purpose / specific material |
| --- | --- |
| `attendance.context.request` | Signed read-only channel context exchange; account/inbox, nonce, observed session |
| `attendance.foundation.request` | `attempt`, `reserve`, live `readback`, positive-proof `close_collision`; stable request UUID and exact candidate/material |
| `attendance.session.observed` / `.proved` | Bounded public PN/LID, verified public-material digest, registration/session digest, provenance, observation UUID/time; verified producer emits `.proved` |
| `attendance.transport.prepared` | Execution/attempt/unit/reservation/ID/recipient/version, preparation UUID/nonce/revision, content/authority/preparation digests |
| `attendance.receipt.observed` | Journal UUID, exact external ID, direct JID/participant/direction, raw class, normalized status/time and fixed protocol metadata |

The APP accepts the foundation/session/prepared contracts in 1B. Receipt event
delivery remains retained for the 1C receiver; no reducer is installed. No
accepted/rejected/released events are fabricated.

All HTTP event traffic reuses `/webhooks/nexi/channels/evolution`, per-instance
event secret, UUID, fresh signature timestamp and existing HMAC envelope.
The prepare API requires both the existing API-key guard and an independently
APP-signed 60-second, preparation-only grant. It never accepts arbitrary API
recipient/content/actor authority. The grant is issued from APP's durable human
execution manifest by an internal worker primitive, without a browser route.

## Durable preparation and restart

Five provider-parity models have no Message/Instance cascading FK:
`NexiManagedTransportContext`, `NexiAttendancePreparation`, `NexiReceiptJournal`,
`NexiAttendanceEventOutbox`, `NexiAttendanceHealth`.
New migrations retain accepted historical migrations unchanged.

Draft identity is `(immutable instance ID, request UUID)` plus input digest.
Each physical unit has its own attempt, reservation and candidate. Stable
request UUIDs for attempt/reserve/readback/closure are persisted before HTTP.
Lost responses recover the same candidate through APP primary readback.
Same identity/different material conflicts. APP reservation UUID and exact ID
are durable before content-dependent preparation is frozen.

Collision replacement requires APP's positive permanent-index collision proof
and locked pre-admission closure. Missing readback alone is insufficient.
The old preparation is fenced permanently; its successor gets a fresh request,
candidate, APP attempt, preparation UUID/nonce/revision. Restart follows the
durable successor. Admission uncertainty denies replacement.

Content digest binds the exact manifest unit, recipient/version, external ID,
execution/attempt/reservation, signed channel/session/sender/epoch authority.
Freeze and prepared event creation commit together. Restore recomputes digests.
Preparation rows use revision CAS, immutable candidate material and one-way
correlation/dispatch timestamps. `outcome_unknown` never means resend permission.
Future admission/release/transport-return columns exist, but 1B SQL forbids
release consumption, dispatch markers, returned wire state and released states.
1C must deliberately extend the state floor and consume APP release authority.

## Receipt semantics and AR-04

Raw capture handles bounded direct PN/LID receipts, excluding Groups. No APP
attempt ownership is inferred. The journal can commit before Message persistence
or Chatwoot correlation. Journal plus immutable outbox event share one transaction.
Persistent source identity excludes capture timestamp/UUID, retaining source
session, external ID, direction, class and original timestamp.

`sender` => SERVER_ACK; absent type => DELIVERY_ACK; `read`/`read-self` => READ;
`played` => PLAYED. Unknown, null/empty or wrong-direction evidence => UNKNOWN.
The separate numeric normalizer preserves 0 ERROR, 1 PENDING, 2 SERVER_ACK,
3 DELIVERY_ACK, 4 READ, 5 PLAYED; other values never become positive evidence.

No undocumented production limits are supplied. Explicit positive configuration
is required for all of:

```
NEXI_ATTENDANCE_QUEUE_ITEMS
NEXI_ATTENDANCE_QUEUE_BYTES
NEXI_ATTENDANCE_APPEND_CONCURRENCY
NEXI_ATTENDANCE_DB_ACQUISITION_TIMEOUT_MS
NEXI_ATTENDANCE_DB_STATEMENT_TIMEOUT_MS
NEXI_ATTENDANCE_DB_LOCK_TIMEOUT_MS
NEXI_ATTENDANCE_APPEND_DEADLINE_MS
NEXI_ATTENDANCE_RECOVERY_ITEMS
NEXI_ATTENDANCE_RECOVERY_BYTES
```

Acquisition and statement limits must be below total deadline; lock limit cannot
exceed statement limit; concurrency cannot exceed queue items. Socket capture
returns after commit or finite deadline. Timed-out work retains its concurrency
slot until settlement, preventing an unbounded unresolved promise tail.
Recovery buffer is capped by items and bytes and only reattempts journal append.

PostgreSQL has pool acquisition, driver query, statement and lock timeouts.
Real MySQL uses a dedicated adapter pool with finite acquisition/socket timeouts,
absolute query/execute timers that destroy only the affected connection, and
server lock timeout rounded to seconds. MariaDB-only `queryTimeout` is removed.
Commit uncertainty is retained as evidence-gap health, not negative send proof.

Degradation trips sticky in-memory and persistent health, emits safe structured
alarm IDs and caps recovery. Historical context restoration requires the exact
immutable instance/session and payload fingerprint and supplies receipt provenance
only. Fresh authority failure leaves customer send classification ambiguous.
Process death between receipt arrival and durable commit can lose evidence.
There is no receipt retransmission or exactly-once WhatsApp delivery guarantee.

## Outbox and isolation

Stable UUID, canonical body, fingerprint and source identity survive retries.
Persistent lease/attempt/backoff metadata bounds HTTP retries to the existing
12-attempt ceiling. HTTP success alone does not settle an event. Terminal APP
ACK must match UUID, fingerprint and version; ACK state/time cannot be reset.
Unsupported versions are retained; exhausted work is quarantined; missing or
disabled bindings retain `binding_unavailable` rows. No endpoint/session fallback.

Classification derives from the authenticated webhook binding and APP-signed
durable context. Disabled/deleted/old-generation records retain managed identity.
Name reuse with a different immutable instance is unresolved, never legacy.
Cutover is hard false in the signed 1B contract. Ordinary non-managed traffic
keeps legacy behavior. Generic/raw callers cannot create a trusted capability.

The only Attendance capability is `foundation_only`, and every use denies wire
dispatch. Completed-stanza equality, the global candidate denial marker, durable
ID lookup, lowest-node gate, exported raw-byte guard and native retry hook give
independent protections. Prepared/reserved IDs never grant retry permission.
Handshake/IQ/ACK/presence and trusted protocol construction remain distinct.
Existing Groups guard and financial signed-recipient/freshness/retry checks are
retained; their domain modules are unchanged. `invoice_url` remains disabled.
WAID alone no longer identifies financial history: outgoing trusted financial
metadata is required. Incoming secondary processing is not delivery failure.

## Tests, source attack and outstanding runtime verification

`attendance-wave1b.test.cjs` covers required A–V behavioral attacks, including
lost responses, collisions, immutable material, public-only attestation,
session replacement, early/deduped/unknown receipts, deadlines/saturation,
stable outbox ACK/retry, raw/native bypass, legacy, Groups and financial parity.
`attendance-source.test.cjs` mutates exact anchors and verifies no partial layer,
raw capture ordering, installed wire gates, compiled model/provider assertions.
`attendance-database.integration.test.cjs` exercises the actual new migrations
and permanent SQL constraints through independent PostgreSQL/MySQL connections.
It is opt-in via `NEXI_ATTENDANCE_PG_TEST_URL` / `NEXI_ATTENDANCE_MYSQL_TEST_URL`,
creates only a random disposable schema/database, and never uses production URI.
Unconfigured DB gates are skipped and must be explicitly run in EasyPanel's
disposable validation environment before accepting database behavior.

Source review re-attacked tenant/channel/sender/session substitution, stale epoch,
lost request/response, post-admission collision, content/recipient/ID replacement,
raw node forging, native cached retry, unknown ACK promotion, crash leases,
outbox body mutation and receipt queue/DB failure. Written guards/tests cover
these cases; runtime success is not claimed.

EasyPanel must validate both actual provider bundles, pinned adapter behavior,
real migrations/constraint enforcement, DB timeout boundaries and all new tests.
MySQL runtime principals must lack DROP/ALTER privileges before future dispatch
activation: TRUNCATE bypasses row triggers. No local schema artifact was invented.
Missing sender-lineage/attestation authority blocks preparation; observations do
not automatically create it. Health clearance and retained-outbox reconciliation
need explicit authenticated operational policy before future activation.

Remaining: 1C exact receipt receiver/dedupe, historical authority/reducer,
admission/release consumption and managed projection; 1D takeover serialization;
1E UI projection; 1F compatible writer/barrier cutover. None is activated here.
