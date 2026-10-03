# Wave 1 R3 lifecycle correction

Verified clean Evolution starting HEAD: `17896c187c891bb437df353840561f17010d7ce4`.
Verified clean APP HEAD: `b38c3f0fdb7f549cefb7b72bbb52186d56e2a998`.
Both remain on `feature/nexi-groups-v1-wave1`. APP requires no source change or
commit. This correction creates one Evolution commit without amending history.
No push, deployment, live WhatsApp action or dependency installation occurred.

## Reproductions and self-review

The harness reconstructs the immutable reviewed helper/patch from `17896c1` and
executes actual transformed production methods. Native profile/privacy,
reloadConnection, connectToWhatsapp, Chatwoot receiveWebhook, createInstance and
Monitor.setInstance retain their awaits. Only network/repository I/O is
synthetic. Historical fire-and-forget reloads are observed by the harness so
their actual socket construction completes before assertions.

| Finding | Historical reproduction | Correction | Executed result |
| --- | --- | --- | --- |
| R3: three profile/privacy methods | A pauses in the actual mutation await, B registers, A resumes; bare reload captures B and creates C. Privacy also mutates B in its remaining awaits. | Immutable operation context and profile target before first await; exact captured socket; original epoch/authority checks after each await; awaited reload receives the original context. | Separate non-skipped replacement, current-owner, manual-disconnect and removal/foreign tests for all three methods pass. B remains current, live, token/status/timers unchanged; no C or late reload. |
| R3: strongest manual-close race | removeProfilePicture pauses; actual Chatwoot disconnect stores manual close; late reload builds one socket; native open stores open; native monitor restart builds another socket. | Manual flag/cancellation epoch and persisted manual state invalidate the original operation. Remote mutation success cannot grant reconnect authority. | All three methods: zero late factory builds, marker/status remain manual/close, stale native open cannot persist, recovery/restart create zero sockets. |
| Same-class createInstance HIGH | Creation pauses in actual settings await; another valid connect registers A; Chatwoot disconnect closes A; old creation resumes and reconnects. | Creation tracks its service and captures original authority before event/proxy/settings awaits; connect inherits that context; stale error cleanup cannot remove the replacement entry. | Historical reproduction passes. Current tests cover replacement, manual close, foreign monitor service and ordinary initial creation. No adoption, late socket or replacement deletion; current creation builds one socket. |
| Same-class startup failure HIGH | Actual Monitor/native connection constructs A and awaits local initialization; B registers; old call fails; startupFailure resolves current B and suspends/ends it. | Pass original startup context through native connect and failure handling. A constructed by that same attempt is an explicit authority handoff, not a late adoption. | Historical reproduction passes. Current test leaves B live and its persisted status/monitor untouched. Existing D2 own-failure/tracking/health/retry cases still pass. |

Four historical reproduction tests, nineteen current race/control tests and the
mechanical audit test run locally without skips. Current R3 tests do not depend
on Git history. Historical-only tests may skip in images without that history.

## Original authority and reload

The existing lifecycleCapture context supplies exact service/socket, registered
owner identity/token, session fingerprint, instance id/name and cancellation
epoch. Context properties remain frozen and non-enumerable. No second ownership
registry, DB token field, schema or migration is introduced.

operationCheck uses existing connectCheck, then reads the same expected DB owner
and rejects missing/foreign ownership or a persisted closed manual marker.
operationAwait checks the original context after the remote/download await and
after the DB authority await. Privacy checks all six mutations; picture upload
also checks its actual axios download boundary. Every mutation uses the captured
socket and immutable profile target. No DB lock spans remote work.

All three callers use `await reloadConnection(nexiOperation)`. connectLifecycle
accepts that original context rather than capturing a later current owner, and
checks its epoch before joining/starting single-flight work and after any prior
cleanup wait. Reload proves authority before ending only the original socket
and constructing its replacement. This avoids leaving two live sockets in the
current-owner control. Completion is checked against the exact returned socket;
a different current socket cannot be adopted at completion. Stale errors retain
the fixed lifecycle code; ordinary errors retain existing API wrapping. Reload
rejection is observed by the caller, so required reload cannot report success
while failing in a dangling Promise.

Manual disconnect, logout, remove/delete, epoch-only cancellation, deleted DB
row and foreign DB ownership all invalidate the old operation. Tests include
replacement during download, each of six privacy awaits, native reload
initialization, and actual monitor removal. An explicit new authorized reconnect
after manual close still permits new current-owner profile/privacy operations;
it does not confer authority on an older operation.

Startup publication handoff is correlated using a non-serialized operation
symbol and the captured cancellation epoch in the existing owner record. This
only proves which original attempt constructed that socket; it is not a new
socket ownership system. The owner record retains no original context chain,
old socket or credential-bearing generation through that correlation. Invalid
origin returns before suspension state, timers, socket end or persistence.

## Mechanical same-class audit

[Complete occurrence inventory and classifications](GROUPS-WAVE1-R3-LIFECYCLE-AUDIT.md)
lists 244 matching calls in transformed runtime/helper source, with scope and
line for every occurrence. Whole-source searches additionally cover route
delegates, non-Baileys providers, AMQP, Redis, file/audio resources and the
socket-local Baileys library. All three native reload callers are now awaited
with the original context. Searches for post-await mutable this.client and
waInstance.client distinguish lifecycle operations from unchanged direct
send/decrypt/presence/media operations.

The audit produced the two additional historical reproductions above. Accepted
Chatwoot/settings/native callbacks, original-owner timers, manual registration
resolution, credential/status CAS and bounded recovery were retained and
rerun. Explicit controller connect originates at entry without an earlier
async boundary before connect; its later wait only reads QR response. Baileys
restart fallback retains its captured socket and has no intervening async
boundary before connect; provider-specific restart is outside the shared
Baileys socket. Startup ownership restoration precedes construction/tracking
of an active generation; connect and failure then carry their original context.

Self-review found no further BLOCKER/HIGH/MEDIUM same-class source defect after
these corrections. Actual database contention and native provider execution are
still runtime gates, not claimed source-test evidence.

## Verification

| Area | Exact result |
| --- | --- |
| Full lightweight Evolution: node --test *.test.cjs | 203 tests: 197 passed, 6 skipped, 0 failed/cancelled. |
| Focused lifecycle: R3, R1/R2, D1/D2, N1 | 59/59 passed, zero skips; includes the historical delta self-review matched by the pattern. |
| New R3 and same-class audit coverage | 24/24 passed, zero skips: 4 historical, 19 corrected race/control tests, 1 mechanical audit. |
| Groups full suite | 90/90 passed; authority, provenance, namespace, retention and privacy regressions retained. |
| Identity/direct transformed source | 19/19 passed. |
| Financial transformed source | 4/4 passed. |
| Transport | 17/17 passed. |
| Patch/bundle structural suite | 68 total: 65 passed, 3 compiled-image skips. |
| Provider schema validation | PostgreSQL, MySQL and psql_bouncer validate using existing Prisma tooling, without DB connection or generation. |
| Syntax | Four changed CJS/MJS files pass node --check; transformed production TypeScript/JavaScript syntax passes. |
| Minification gate | Actual extracted reload/profile/privacy methods minify with existing esbuild and preserve the operation/reload runtime markers. No compiled provider image is claimed built. |
| Diff | Both repositories pass git diff --check. |
| APP frozen Groups/N6 harnesses | 30 tests / 247 assertions: 13/38, 8/83, 9/126; zero failures/errors/skips. APP has no diff or commit. |

After correcting the runtime assertion to use minification-stable call/string
markers, the mechanical audit/minification test was rerun separately: 1/1 pass,
zero skips. The runtime assertion syntax and diff check also pass. Core source
did not change after the full 203-test run.

R1 committed registration/lost response/manual logout/authoritative cleanup and
restart still produces zero sockets; its foreign owner remains untouched. R2
Chatwoot and settings await/replacement tests preserve B, with current-owner
controls intact. Native D1 408 CAS race and current 408 behavior pass. D2 startup
failures remain tracked, capped-backoff recovery succeeds, and one socket is live.

Actual patched Baileys pre-ACK receive harness passes: durable admission failure
emits zero receipt, ACK and NACK and consumes no Signal state. Successful enqueue,
process-death and replay cases remain idempotent. Recovery never acknowledges a
failed packet to restore availability.

Focused direct checks retain PN/LID, native 408/reconnect, stream-515, manual
disconnect, restart, QR/pairing, readiness and Chatwoot sync. Financial recipient
proof, PIX/boleto, outcome_unknown, ambiguous delivery protection and native
retry suppression pass unchanged. N2 destination classification, N3 catalog
invalidation, N4 session source namespace, N5 online/offline privacy and N6 APP
Result/CAS remain accepted and passing/frozen.

## Runtime skips and promotion gates

Six explicit suite skips remain: three compiled-image tests; isolated real
PostgreSQL without a test URL; real Redis without its test server; generated
runtime-model test without its bundle artifact. Compiled provider images,
actual Prisma ownership/transaction contention, Redis and isolated real
WhatsApp socket/reload/restart/offline receive remain promotion gates. APP
Rails/RSpec/real DB were not rerun in this Evolution-only source correction.
No runtime gate is represented as passed, and R3 depends on no skipped test.

The four previously documented unrelated APP baseline failures were not rerun
in this task; APP source remains exactly at the accepted frozen HEAD. They are
not counted as passing tests or new regressions.

## File manifest

- `nexi-groups.cjs`
- `patch-groups-source.mjs`
- `groups-wave1.test.cjs`
- `assert-groups-runtime.mjs`
- `GROUPS-WAVE1.md`
- `GROUPS-WAVE1-R3-LIFECYCLE.md`
- `GROUPS-WAVE1-R3-LIFECYCLE-AUDIT.md`
