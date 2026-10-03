# Wave 1 final N1 lifecycle correction — D1 and D2

Evolution parent: `a9fb4cbf9e3d0c84ef77b7e8ea728efdc37d1b3a`.
APP remains at `b38c3f0fdb7f549cefb7b72bbb52186d56e2a998`; no APP correction is required. No prior commit is amended. No push, deployment, live WhatsApp operation or dependency installation is part of this correction.

## Reproductions and self-review

The lightweight harness reconstructs the immutable reviewed patch/helper from Git and executes its actual native TypeScript methods. Current-source tests execute the transformed methods too. Network sockets and repository responses are synthetic; `connectionUpdate`, `Monitor.setInstance`, connection wrappers, teardown and relevant control methods retain their native awaits.

| Finding | Historical reproduction | Correction | Regression evidence | Result / runtime gate |
| --- | --- | --- | --- | --- |
| D1 HIGH | Native A/408 callback pauses in real status persistence; B registers; A resumes and calls B.ws.close/B.end and writes close. Both observed effects are asserted against reviewed history. | Immutable physical client, instance, session fingerprint and opaque ownership snapshot; checks after async boundaries; every native lifecycle status write predicates the expected DB owner token and requires exactly one row. Socket-owned timers and cleanup/control callbacks retain the same context. | Real native A/408 across await: B stays open, B status/state/token remain intact, no stale effects. Current A/408 retains close/end without immediate reconnect. Profile, pairing, QR completion, delayed expiry, stream-515, cleanup and controller tests cover additional boundaries. | Source reproduction closed. Real provider image/native socket and independent PostgreSQL ownership/cleanup contention remain runtime gates. |
| D2 HIGH | Actual reviewed Monitor.setInstance awaits native connect/registration rejection before adding waInstances; startup rejects and recovery tracking is absent. The persisted suspension marker remains. | Register Baileys services before connection, retain recoverable failure, remember exact proposed registration tokens, resolve only that proposal or the captured owner before retry, and retire foreign/stale entries without deleting a replacement. | Actual Monitor/native connect with failure before registration, uncertain committed registration, failure after socket construction, restart suspension, new recoverable startup, outage/backoff, foreign owner and manual-close cases. Healthy retry yields one live socket and direct PN/LID transport resumes. | Source reproduction closed. Disposable DB and isolated native recovery are runtime gates. |

The final source audit also reproduced/closed stale delayed deletion, stale credential cleanup, stale control-endpoint completion, manual stop during an awaited registration, and uncertain first registration. These are N1 lifecycle paths, not product or Groups authority redesign. The tests verify ownership before/after native awaits, including cleanup before a late monitor deletion; a manual cancellation resolves/refunds only its own pending registration proposal before credential cleanup. No new BLOCKER/HIGH/MEDIUM source finding remains identified by this self-review. Runtime verification is not represented as complete.

## Ownership and persistence

All Baileys socket generations register using the existing `Instance.nexiGroupsSocketOwner` field. This extends fencing to ordinary native connection callbacks as required by D1; special admission health/recovery remains limited to managed instances. A physical client is published inside the installation boundary only after ownership registration succeeds. A connection attempt is single-flight per service and keeps its captured context through asynchronous initialization. A manual stop changes a cancellation epoch so an already-awaiting connect cannot publish a socket afterward.

`persistLifecycle` uses `updateMany(id, expected owner token)` and requires count one. Zero rows means stale ownership and exits before destructive actions. Close, open, QR/connecting, disconnect fields and recovery status are fenced. Lifecycle contexts and loader ownership hints have non-enumerable properties; instance-info responses omit the internal DB token.

Credential/session cleanup and captured credential saves take a per-instance parent ownership lock using the same CAS in a transaction. Replacement registration serializes against that cleanup; every subsequent native async boundary rechecks its captured owner. This adds no account/global locks. Only the Groups recoverable marker is replaced with a fixed manual-close marker, using a Prisma JSON equality filter; other native disconnect reasons remain intact. Completed manual close therefore cannot become recoverable merely because an earlier 503 marker existed.

Reconnect timers belong to their creating socket. A stale timer cannot reconnect, cancel replacement timers or change ownership. Monitor expiry stores and removes only its own handle; stale `finally` completion cannot delete B's timer. Stream-error, QR and pairing callbacks use the captured generation. Logout/remove/no-connection handlers and asynchronous logout/delete endpoints carry the originating context. Explicit restart uses the captured physical socket. Native direct 408 behavior and stream-515 grace behavior remain covered.

## Recovery semantics

The existing 15-second worker still iterates monitor entries; recoverable construction failures now remain in that registry. Retry is due-time gated, exponential and capped at 300 seconds. Simultaneous ticks/connections cannot create duplicate sockets. A healthy rollback-only canonical outbox INSERT/control-CAS probe is required before suspended receive resumes. Registration uncertainty does not create a socket before the outcome is resolved: only a token proposed by that service may be adopted. A foreign token retires its pending entry; a replacement monitor entry is never removed. No manual/permanent close is automatically resurrected.

Failed managed admission still rolls back Signal consumption, emits no receipt/ACK/NACK and suspends only the originating socket. Recovery does not ACK the failed packet. Successful canonical enqueue survives process death, and replay is idempotent. No history import or guarantee of indefinite WhatsApp server retention is added.

## Verification

Final command: `node --test *.test.cjs` — **164 tests: 158 passed, 6 skipped, 0 failed/cancelled**.

| Area | Executed result |
| --- | --- |
| Groups full lightweight suite | 51/51 passed; includes actual transformed receive, authority, privacy, dedupe, bounded outbox and provider-parity checks. |
| Lifecycle subset | 19/19 passed: 17 D1/D2 tests plus two prior N1 tests, including two historical reproductions. |
| Native direct 408/reconnect and monitor recovery | Passed within the lifecycle subset; includes current/stale 408, stream-515 grace, ordinary reconnect, open/connecting, explicit disconnect/restart, QR/pairing, PN/LID and direct Chatwoot. |
| Identity/direct transformed source | 19/19 passed, with realistic message IDs and accepted readiness/provenance checks. |
| Financial transformed source | 4/4 passed; transport suite also 17/17 passed, retaining recipient/destination proof, PIX/boleto, outcome_unknown and native retry suppression. |
| Patch/bundle structural suite | 68 tests: 65 passed, 3 compiled-image skips. Pinned source anchors, transformed TypeScript/JavaScript syntax and combined patches pass. |
| Prisma schemas | PostgreSQL, MySQL and psql_bouncer validate using existing tools; no client generation, database connection or installation. |
| Syntax and diff | Five edited JS/CJS/MJS files pass `node --check`; `git diff --check` passes. |
| N2–N6 | N2–N5 production regression cases pass; N6 APP source and accepted HEAD are unchanged. No APP lifecycle integration change is necessary. |

Six explicit skips: three compiled-image tests; real PostgreSQL without `NEXI_GROUPS_PG_TEST_URL`; real Redis without a test server; generated/built runtime-model test without its artifact. PostgreSQL test definitions now execute production lifecycle CAS against independent connections and serialize parent cleanup/replacement, including the JSON manual-close marker. No real database execution is claimed.

Remaining gates: build provider images and run compiled lifecycle assertions; apply existing migrations to disposable PostgreSQL/MySQL; execute actual Prisma CAS/transaction contention and lease tests; run isolated native WhatsApp lifecycle/offline receive/recovery with supported dependencies and no production account. APP Rails/RSpec is outside this Evolution-only correction and remains a companion promotion gate from the accepted wave. No dependencies were installed.

## File manifest

- `nexi-groups.cjs`
- `patch-groups-source.mjs`
- `groups-wave1.test.cjs`
- `groups-postgresql.integration.test.cjs`
- `assert-groups-runtime.mjs`
- `GROUPS-WAVE1.md`
- `GROUPS-WAVE1-N1-LIFECYCLE.md`
