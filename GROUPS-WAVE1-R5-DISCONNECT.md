# Wave 1 R5: manual disconnect despite remote logout failure

Verified clean starting state on `feature/nexi-groups-v1-wave1`:

- Evolution: `afa0bf2c995574f6f7d484fe9be92f900e2ac6cb`.
- APP: `b38c3f0fdb7f549cefb7b72bbb52186d56e2a998`, frozen and unchanged.

One Evolution correction commit is created directly above that HEAD. No amend,
push, deployment, live WhatsApp action or dependency installation. APP, lifecycle
helpers, profile/privacy methods, readiness rules, Groups/pre-ACK/financial
semantics, pins, schemas and Dockerfile are unchanged.

## Historical reproduction and native semantics

An executable test reconstructs the immutable reviewed helper/source patch from
`afa0bf2`. Actual transformed Chatwoot receiveWebhook and native lifecycle methods
retain their awaits. The fixture uses Baileys' native websocket state getters.
The pinned SDK logout, sendNode, sendRawMessage and end functions are extracted
and executed; only network encoding/send, event I/O and repository I/O are
synthetic. No websocket connect or real network operation is performed.

Pinned logout first sends remove-companion-device, then calls native end.
sendRawMessage rejects with Connection Closed/status 428 when websocket is not
OPEN. On CONNECTING, logout therefore rejects before end/Signal cleanup.

The historical test starts from ordinary DB state open, with no Groups suspension
marker. It proves the old Chatwoot result is only `{ message: 'bot' }`, the
physical socket remains CONNECTING, marker remains null, DB remains open, and
actual native Monitor restart constructs one socket. This reproduction passed
locally without skips before correction and remains in the regression suite.

## Surgical correction and authority

Only the existing transformed Chatwoot disconnect branch is changed. It retains
the original R2 entry context: exact service/socket, owner/token, session/instance
identity and cancellation epoch, including monitor ownership. It never resolves
a new target through mutable waInstance.client after an await.

Existing manualLifecycle establishes cancellation/manual intent immediately and
clears that owner's timers/recoverable flag. Its existing pending-registration
resolution and CAS conventions are retained. The disconnect work then:

1. Persists explicit owner-fenced close, nexi_socket_manual_close and reason 401
   before response/protocol awaits. No Groups suspension marker is required.
2. Sends the existing pending bot response best-effort, with original ownership
   checks and fixed diagnostics.
3. Re-proves DB ownership after that await. OPEN/CONNECTING may attempt pinned
   remote logout; CLOSING/CLOSED skip unsupported protocol work.
4. Classifies a native 428 failure as transport_unavailable and other protocol
   failures as failed. Ownership staleness propagates instead of being swallowed.
   Logs use fixed codes, never the raw protocol error.
5. Re-proves DB authority after logout before local fallback. Calls only the
   captured socket's idempotent native end, releasing Signal/event resources even
   for already-closed transport. Closes the captured websocket if still needed;
   never constructs a socket or touches a replacement.
6. Completes owner-fenced manual-state persistence and updates local state only
   after that succeeds. Final bot notification failure is handled separately.

No DB lock spans the bot response, protocol send or physical teardown awaits.
The existing narrow cleanupLifecycle/persistLifecycle transactions and expected
affected-row checks supply the CAS fences. Manual intent invalidates older
profile/privacy work, native OPEN callbacks and recovery eligibility.

The existing `message: 'bot'` contract gains explicit lifecycle/remoteLogout
metadata for this command: disconnected with succeeded, transport_unavailable or
failed protocol outcome; superseded for lost ownership; disconnect_failed for
unconfirmed persistence/teardown. Failed CAS/persistence never reports successful
disconnect. An initial persistence failure cannot be claimed as durable shutdown.

## Executed R5 self-review

Ten R5 tests pass locally without skips: one historical reproduction and nine
current correction tests. Several tests loop over multiple states/races.

- Plain CONNECTING + ordinary open DB/no marker + native failing logout: exact
  socket closes, native Signal cleanup executes, owned timers clear, manual state
  persists, late actual native OPEN cannot overwrite it, recovery/restart build
  zero sockets. The attempted native remove-companion-device never sends.
- Separate tests for privacy, picture update and picture removal: legitimate
  reload constructs CONNECTING B; completion pauses at DB validation; actual
  Chatwoot disconnect uses pinned failing logout; old operation rejects stale;
  B ends, manual state persists, no late factory builds or restart sockets.
- OPEN native protocol logout succeeds. CLOSING/CLOSED skip remote work and use
  idempotent local teardown; no new socket is built. A transport already CLOSING
  finishes its existing close rather than reconnecting. Repeated disconnect is
  safe, and every state remains closed to automatic restart.
- Replacement during the native failed-logout boundary preserves B, its timer,
  monitor entry, physical state and DB fields. Foreign DB ownership both after
  pending bot response and after failing logout is rejected without adoption,
  foreign-state mutation or fallback teardown.
- Initial DB unavailability/lost CAS and final persistence failure after physical
  end return explicit failure/superseded outcomes, not false success.
- Other native send failure reports remoteLogout failed while local shutdown
  succeeds; diagnostics contain only the fixed code, not raw protocol content.

All eleven R4 tests pass: authoritative CONNECTING/OPEN acceptance, dead/invalid
transport rejection and authority-loss/manual boundary protections. R3 tests
remain passing for all three methods, including deletion/removal, foreign owner
and no-resurrection. R1, R2, settings, delayed instance creation, stale startup
failure, native D1 and monitored bounded D2 recovery remain passing.

Self-review found no new BLOCKER/HIGH/MEDIUM defect introduced by this surgical
correction. No broad source review or inventory rewrite was performed.

## Exact verification

| Area | Final local result |
| --- | --- |
| Historical R5 alone, before correction | 1/1 passed, zero skips; proves the bad historical outcome |
| Focused lifecycle, inventory test excluded | 79/79 passed, zero failures/skips |
| R5 coverage | 10/10 passed, zero skips |
| R4 coverage | 11/11 passed, zero skips |
| Groups suite, explicit inventory test exclusion | 110/110 passed, zero failures/skips |
| Other seven lightweight test files | 113 total: 107 passed, 6 skipped, zero failures |
| Combined final validation | 223 reported tests: 217 passed, 6 skipped, zero failed/cancelled; one requested inventory test omitted |
| Identity/direct | 19/19 passed |
| Financial source | 4/4 passed |
| Transport | 17/17 passed |
| Patch/bundle structural | 68 total: 65 passed, 3 compiled-image skips |
| Provider validation | Existing Prisma validates PostgreSQL, MySQL and psql_bouncer without DB connection or generation |
| Syntax | Both changed CJS/MJS files pass node --check; transformed production syntax/patch structural tests pass |
| Diff | Both repositories pass git diff --check |

Final commands:

```
node --test --test-name-pattern '^(?!R3 same-class mechanical audit).*(R[1-5]|D[12]|N1)' groups-wave1.test.cjs
node --test --test-skip-pattern 'R3 same-class mechanical audit' groups-wave1.test.cjs
node --test bundle-patch.test.cjs financial-delivery-source.test.cjs groups-postgresql.integration.test.cjs identity-foundation-source.test.cjs nexi-transport.test.cjs redis-lua.integration.test.cjs runtime-model.test.cjs
```

The requested inventory exclusion failed in two preliminary wildcard runs despite
the name filters; its automated contract executed there (224 total, 218 passed,
6 runtime skips, zero failures). No inventory document changed. The final split
commands above explicitly omit it; its absence is confirmed in the Groups log.

Actual patched Baileys pre-ACK receive regression passes: failed admission produces
zero receipt, ACK or NACK, with durable enqueue/replay idempotence preserved.
Direct smoke retains PN/LID, reconnect/408/stream-515, manual disconnect, restart,
QR/pairing, readiness and Chatwoot sync. Financial recipient proof, PIX/boleto,
outcome_unknown, ambiguity protection and native retry suppression pass unchanged.
N2-N6 remain frozen; APP tests are not rerun for this Evolution-only correction.

Six runtime skips remain: three compiled-image tests, isolated real PostgreSQL
without a test URL, real Redis without its server, and generated runtime-model
artifact without its bundle. Compiled provider images, real DB contention,
Redis and isolated real WhatsApp are unexecuted runtime gates, not passes.
R5 depends on no skipped test.

## Changed files

- `patch-groups-source.mjs`
- `groups-wave1.test.cjs`
- `GROUPS-WAVE1-R5-DISCONNECT.md`
