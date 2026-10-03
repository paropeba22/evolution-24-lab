# Wave 1 residual lifecycle correction — R1 and R2

Verified clean starting Evolution HEAD: `99ab770105fa6de3608a7dedf959ff845eb67048`.
Verified clean APP HEAD: `b38c3f0fdb7f549cefb7b72bbb52186d56e2a998`.
Both use `feature/nexi-groups-v1-wave1`. APP requires no change or commit.
One new Evolution commit preserves all previous commits. No push, deployment,
live WhatsApp operation or dependency installation occurred.

## Historical reproductions and correction evidence

The harness reconstructs the reviewed `99ab770` helper and source patch from
Git. It executes native/transformed `connectToWhatsapp`, `logoutInstance`,
`Monitor` and the complete Chatwoot `receiveWebhook` method with synthetic I/O.
Native awaits are retained. Current-source regression tests use the same
method extraction. These are executable tests, not substitute lifecycle logic.

| Finding | Historical reproduction | Correction | Current regression result |
| --- | --- | --- | --- |
| R1 HIGH | Registration commits its proposed token, response is held, manual logout begins, response throws. Old cleanup CAS misses; connecting/admission-suspended survives. Native monitor restart creates one socket. | Immediate existing manual cancellation epoch, wait for the preexisting single-flight connection, then authoritative ownership reread before cleanup. Resolve only expected/proposed tokens. Atomic proposal refund also persists explicit manual close. | Proposed token and true noncommit both finish manual cleanup without stale exception; native restart and recovery produce zero sockets. Foreign owner remains untouched; old entry and exact old socket retire. Actual monitor deletion clears the marker and deletes the row. Automatic technical recovery without manual action still works. |
| R2 HIGH | Actual Chatwoot `/disconnect` pauses in `createBotMessage`; B replaces A; resumed command calls B.logout and B.ws.close. | Capture immutable service/socket/instance/owner at webhook entry, recheck after initial delay and client initialization, use captured owner for manual disconnect and init/iniciar. Every destructive await uses lifecycle checks; status writes use existing owner CAS. | Replacement survives bot-message and logout waits, with status, monitor and timers intact. Stale response is superseded and never claims successful disconnect. Current `/disconnect` and `/desconectar` retain logout/close. PN/LID direct Chatwoot and current init remain functional. |
| Equivalent R2 HIGH found in final audit | Native `setSettings` pauses in its setting upsert, then closes/connects mutable B.ws. Historical test proves both effects. | Capture owner before upsert, validate before applying local settings or closing, use exact captured websocket, recheck before reconnect. | Stale update performs neither B.close nor B.connect; current-owner settings retain their close/connect behavior. |

All three historical reproductions and all twelve corrected R1/R2 regression
tests ran without skips. Historical-only tests may skip in provider images that
omit Git history; the current exact R1/R2 combination tests do not depend on it.

## Uncertain ownership and manual intent

The proposed registration UUID is recorded before the DB call. Manual intent
advances the existing cancellation epoch and cancels only that owner's timers
before waiting for the already-running connection task. A thrown registration
response cannot be treated as proof of noncommit.

After that task settles, manual cleanup rereads the authoritative instance:

- Proposed UUID belonging to this owner: CAS that exact UUID back to the captured
  expected owner and atomically store `close`, `nexi_socket_manual_close`, 401.
  Continue existing credential/delete cleanup under its normal ownership lock.
- Expected previous UUID: registration did not commit, or a refund already
  committed; continue cleanup with that still-authoritative owner.
- Foreign/newer UUID or deleted row: retire only the old service's monitor entry
  and exact physical socket. Do not adopt, refund, delete or mutate foreign DB
  ownership or a replacement monitor/socket.

A lost refund response is resolved by one further authoritative reread. This
resolution is bounded to two attempts and throws an explicit unresolved error if
authority/storage cannot be established; it does not report completed cleanup.
There is no automatic busy retry. All DB mutations predicate the expected token
and require one affected row. No token or context is exposed in logs/responses.

Suspension persistence now takes the existing per-instance owner lock in a
transaction, checks manual/physical ownership after acquiring it, then writes
the recoverable reason. Manual cleanup uses the same lock. An older in-flight
suspension write either commits before manual cleanup, or observes manual intent
and writes nothing. It cannot restore the technical marker after completed
authoritative manual cleanup. No broad lock or new schema is introduced.

Restart only recognizes the exact technical suspension reason. Successful
authoritative manual logout/delete leaves no such reason, so native monitor
startup and recovery cannot resurrect it. Ordinary technical suspension still
requires the existing rollback-only durable admission write probe, ownership
resolution, single-flight connection and capped backoff. A storage outage during
manual cleanup is an explicit failure, not a falsely completed durable close.

## Chatwoot lifecycle control audit

The only BOT_CONTACT lifecycle commands are init/iniciar (connect) and
disconnect/desconectar (logout/close). Status and clearcache do not create or
destroy sockets. Entry ownership checks cover the initial delay, clientCw await
and command dispatch. Connect executes under the captured lifecycle scope;
disconnect runs the existing manual lifecycle resolution and owner-fenced
cleanup, then uses only the captured socket for logout/ws.close.

A pending status response precedes the operation; the disconnect success
translation is emitted only after owned close and persistence. A failed pending
notification cannot strand a cancelled owner with a live socket: validate that
the owner is still current, record a fixed diagnostic and continue disconnect.
A stale notification completion exits as superseded before any socket action.
Tests cover both notification failure and replacement during that await.

## Final targeted post-await audit

| Runtime-relevant occurrence | Ownership outcome |
| --- | --- |
| Native connectionUpdate status, close/end, QR/profile/pairing and stream-515 | Accepted captured owner, post-await checks, status CAS and owner-bound timers retained; D1 tests rerun. |
| Native logoutInstance and credential cleanup | Existing manual owner/context, exact socket and parent ownership lock; R1 resolution now runs before work. |
| Monitor delayed expiry, remove/logout/no.connection and cleanup | Existing captured socket/service, guarded awaits and per-entry removal/timer checks retained; D1/D2 tests rerun. |
| Instance controller logout/delete/restart | Accepted captured ownership across connectionState/logout waits and exact restart socket retained. |
| Chatwoot lifecycle commands | R2 correction above; no additional delete/restart/close command exists in chatbot source. |
| Channel setSettings wavoip websocket restart | Equivalent stale-socket race reproduced and fixed in this correction. |
| Baileys library end/close/timers | Socket-local closure resources; no mutable provider-service client lookup. |
| Redis `.client.connect`, direct send/relay/presence/media calls and non-Baileys channels | Not destructive operations on the shared Baileys service lifecycle; no redesign or transport/financial change. |

Self-review found and closed the equivalent settings race and prevented the new
pending-notification failure from stranding a manually cancelled live socket.
No further BLOCKER/HIGH/MEDIUM source finding was identified. This statement
does not replace the independent acceptance review or remaining runtime gates.

## Verification

Final `node --test *.test.cjs`: **179 tests, 173 passed, 6 skipped, 0 failed or
cancelled**. Focused `R[12]|D[12]|N1`: **35/35 passed, zero skips**, including the
historical delta reproduction matched by that pattern.

| Area | Result |
| --- | --- |
| Groups full lightweight suite | 66/66 passed. |
| R1/R2 exact combinations, ownership outcomes and targeted audit | 15/15 passed, including 3 historical and 12 corrected tests. |
| Accepted D1/D2 and prior N1 lifecycle cases | 19/19 passed: native 408 across await, current 408, bounded monitor retry, uncertain startup registration, one live socket, foreign retirement and manual close. |
| Direct/identity transformed harness | 19/19 passed: realistic PN/LID IDs, recipient/destination proof, readiness and native retry behavior. |
| Financial transformed harness | 4/4 passed; PIX/boleto, recipient proof, outcome_unknown and ambiguous delivery remain covered by this and the transport harness. |
| Transport harness | 17/17 passed: shared delivery proof, ambiguous outcomes and native retry suppression preserved. |
| Patch/bundle structural tests | 68 total: 65 passed, 3 compiled-image skips. Combined pinned transforms and syntax pass. |
| Prisma provider validation | PostgreSQL, MySQL and psql_bouncer all validate with existing tools; no generation, install or DB connection. |
| Explicit syntax/diff | Five edited CJS/MJS files pass node --check; both repositories pass git diff --check. |
| APP Groups/N6 | Unchanged source; rerun 30 tests / 247 assertions across three lightweight suites: all pass, no skips. |

Pre-ACK regression executes the actual patched Baileys receive path: failed
canonical admission emits zero receipt, ACK or NACK and consumes no Signal key;
successful enqueue and process-death/replay cases remain idempotent. Recovery
never acknowledges the failed packet as a substitute for admission.

N2 destination classification, N3 raw invalidation, N4 session namespace and N5
online/offline privacy regressions pass unchanged. APP N6 service call graph,
typed Result/CAS and compensation regression harness passes unchanged.

Four previously documented APP baseline-equivalent failures were rerun:
automation missing Platform::ErpError; ERP transport missing settings; ERP
context missing Platform::ErpFinancialProjection (27 runs/322 assertions, one
error); ERP response auth existing dispatch assertion (14/204, one failure).
Their source/test files have zero diff from accepted APP baseline `04fef75`.
They are neither new regressions nor reported as passing tests.

Six Evolution runtime skips remain: three compiled-image tests, real PostgreSQL
without a disposable test URL, real Redis without its test server, and generated
runtime-model test without its bundle artifact. PostgreSQL definitions now also
exercise production uncertain registration/manual resolution for proposed,
previous and foreign ownership using independent connections; they were not
executed locally. APP Rails/RSpec and real DB were not rerun in this source-only
Evolution correction.

Promotion gates: compiled provider images/runtime assertions; actual Prisma
ownership/transaction contention on disposable PostgreSQL/MySQL; Redis; isolated
real native WhatsApp socket, outage, restart and offline replay. None is claimed
passed. No new migration or APP change is required.

## Files changed

- `nexi-groups.cjs`
- `patch-groups-source.mjs`
- `groups-wave1.test.cjs`
- `groups-postgresql.integration.test.cjs`
- `assert-groups-runtime.mjs`
- `GROUPS-WAVE1.md`
- `GROUPS-WAVE1-RESIDUAL-LIFECYCLE.md`
