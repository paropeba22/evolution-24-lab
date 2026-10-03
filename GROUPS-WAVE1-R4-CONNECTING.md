# Wave 1 R4: authoritative CONNECTING reload

Verified clean starting state, branch `feature/nexi-groups-v1-wave1`:

- Evolution: `ec15120a572e2ba21c6f756ec268d98e50b70a03`.
- APP: `b38c3f0fdb7f549cefb7b72bbb52186d56e2a998`, frozen and unchanged.

One Evolution correction commit is created directly above the reviewed HEAD.
No amend, push, deployment, live WhatsApp action or dependency installation.
No APP, financial, Groups domain, pre-ACK, pin, Dockerfile or schema changes.

## Historical reproduction

The test reconstructs the immutable helper and source patch from `ec15120`.
Actual transformed production updatePrivacySettings, updateProfilePicture,
removeProfilePicture and reloadConnection execute with their original awaits.
Only I/O/construction is synthetic. The resulting transport uses the installed
pinned Baileys WebSocketClient's actual getters and ws readyState constants,
without calling connect or creating a real network connection.

For each operation, the original OPEN socket mutates successfully and closes;
exactly one new authoritative socket is constructed in CONNECTING. The DB token
matches its registered owner, but the prior operationCheck throws
NEXI_SOCKET_LIFECYCLE_STALE because isOpen is false. This executable historical
reproduction passes locally without a skip, both before and after correction.

## Caller analysis and correction

| operationCheck caller | Transport requirement | Context origin |
| --- | --- | --- |
| Three profile/privacy method entries | OPEN before remote mutation | Original operation entry, before relevant awaits |
| operationAwait after six privacy mutations, picture download/upload and removal | OPEN for the existing mutation socket | Same immutable entry context, not current socket recapture |
| reloadConnection before ending original socket | OPEN | Original context supplied by profile/privacy caller |
| reloadConnection after createClient returns | OPEN or CONNECTING; never dead/unknown | Exact returned socket plus the existing registered owner/session/instance/epoch context |

These are all operationCheck/operationAwait runtime callers. The existing
lifecycleCapture ownership abstraction and callers are unchanged; readiness does
not alter their authority semantics. The accepted 244-call inventory is not
rewritten or broadly re-reviewed. Existing mechanical contract tests run as part
of the mandatory lightweight suite.

operationCheck now takes `{ requireOpen = true }`. Only the post-construction
reload call explicitly passes `{ requireOpen: false }`. Both modes preserve
original service/socket/owner/session/instance/cancellation lineage, current
monitor registration and expected database ownership checks. Both reject
CLOSED, CLOSING, uninitialized or unknown transport. The construction mode
accepts only OPEN or CONNECTING, not arbitrary isOpen=false states.

Authority and the appropriate transport predicate are checked before and after
the awaited DB read. Thus termination, replacement, cancellation or deletion
during that await cannot produce false success. Foreign DB ownership remains
rejected without adoption or mutation.

Pinned native reloadConnection historically returns createClient's constructed
socket; it does not promise a wait for websocket OPEN. This correction preserves
construction completion semantics without adding a readiness wait, listener,
timer, retry, socket or ownership system. OPEN alone still cannot prove authority.

## Executed R4 coverage and self-review

Eleven new executable tests, locally 11 passed / zero failed / zero skipped:

- Historical reviewed-source reproduction loops over all three operations.
- Separate legitimate CONNECTING and OPEN controls for each operation: success,
  exact installed resulting socket/DB token, one reload, one live/progressing
  socket and no duplicate construction. All mutations remain on original A.
- CLOSED, CLOSING and uninitialized results fail for all three operations.
- CONNECTING at mutation entry does not grant OPEN readiness; zero mutation or
  reload is attempted for all three operations.
- Completion DB await races reject replacement, foreign DB token, deleted row,
  CLOSED/CLOSING transport and cancellation epoch change. Replacement/foreign
  state and socket effects remain untouched.
- Actual Chatwoot manual disconnect during the new CONNECTING completion wins
  for all three operations. Manual marker/status persist, late native OPEN cannot
  overwrite them, recovery creates no socket, and native monitor restart creates
  zero sockets.

Fixture transport state is now intentional and opt-in: R4 controls specify A as
OPEN and normal new sockets as CONNECTING (or OPEN for the explicit control).
Unrelated fixtures retain their prior OPEN behavior. Tests use native Baileys
state getters, not an isOpen-only approximation, and capture the actual guarded
socket returned by installation rather than comparing it to the raw factory
object. Current R4 correction tests do not depend on historical Git availability.

R3 replacement, pending mutation/manual close/restart, deletion/removal and
foreign ownership tests remain passing for all three methods. Delayed instance
creation and stale startup failure tests remain passing. R1 uncertain committed
registration/manual resolution/restart and foreign ownership; R2 Chatwoot;
settings websocket; native D1 408; and D2 monitored bounded recovery remain
passing with their accepted current-owner controls.

Self-review identified no new BLOCKER/HIGH/MEDIUM source defect in this change.
The accepted lifecycle architecture and ownership rules remain unchanged.

## Verification

| Command/area | Exact local result |
| --- | --- |
| node --test --test-name-pattern 'R4 historical reproduction' groups-wave1.test.cjs, before correction | 1/1 passed, zero skips; proves the historical bad outcome for all three methods |
| node --test --test-name-pattern 'R4' groups-wave1.test.cjs | 11/11 passed, zero skips |
| node --test --test-name-pattern 'R[1-4]\|D[12]\|N1' groups-wave1.test.cjs | 70/70 passed, zero skips |
| node --test *.test.cjs | 214 total: 208 passed, 6 skipped, 0 failed/cancelled |
| Groups | 101/101 passed |
| Identity/direct | 19/19 passed |
| Financial source | 4/4 passed |
| Transport | 17/17 passed |
| Patch/bundle structural | 68 total: 65 passed, 3 compiled-image skips |
| Prisma normal lightweight validation | PostgreSQL, MySQL and psql_bouncer validate without DB connection or client generation |
| Syntax | All three changed CJS/MJS files pass node --check; transformed production syntax passes in the normal suite |
| Diff | Both repositories pass git diff --check |

The actual patched Baileys receive test retains zero receipt/ACK/NACK on failed
durable admission, with successful durable enqueue/replay idempotence. Existing
direct checks cover PN/LID, ordinary/native 408 reconnect, stream-515, manual
disconnect, restart, QR/pairing, readiness and Chatwoot synchronization. Financial
recipient proof, PIX/boleto, outcome_unknown, ambiguous delivery protection and
native retry suppression remain passing. N2-N6 are frozen, with existing focused
Evolution checks passing and APP source unchanged; APP tests are not rerun for
this Evolution-only readiness correction.

Six explicit suite skips remain: three compiled-image tests, isolated real
PostgreSQL without a test URL, real Redis without its server, and generated
runtime-model artifact without its bundle. Compiled provider images, real DB
contention, Redis and isolated real WhatsApp are unexecuted promotion/runtime
gates, not passes. R4 itself depends on no skipped test.

## Changed files

- `nexi-groups.cjs`
- `patch-groups-source.mjs`
- `groups-wave1.test.cjs`
- `GROUPS-WAVE1-R4-CONNECTING.md`
