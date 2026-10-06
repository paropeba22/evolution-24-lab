# Wave 1C final Slice 4/5: authority and transport fence

Source implementation only. Physical Attendance dispatch is disabled. Cutover,
WriterBarrier activation, BIA/takeover and deployment are outside this slice.
Runtime acceptance is still pending; the source tests do not certify a live DB.

## Ownership and complete path

| Stage | Owner | Durable evidence |
| --- | --- | --- |
| Intent, execution, immutable manifest and permanent Message ownership | APP | Slice 3 execution/projection |
| Per-unit preparation/admission/release/consumption identities | APP | `NexiAttendanceOrchestration` |
| Preparation authorization | APP | Existing foundation request |
| Candidate external ID and immutable preparation | Evolution | Existing preparation row |
| Attempt registration and permanent namespace reservation | APP | Existing foundation request/attempt/reservation |
| Prepared content and preparation digest | Evolution | Frozen preparation + prepared event outbox |
| Authenticated prepared proof | APP | Slice 2 receipt observation/context and verified attempt proof |
| Original terminal admission and bounded grant | APP | Existing `NexiOutboundAdmissionDecision` |
| Current authority revalidation and terminal release | APP | Same admission row, original release identity |
| Write-once consumption | Evolution | Exact released material and consumption identity on preparation |
| `dispatch_ready_but_disabled` | Evolution | Consumption committed; no dispatch-start/write |
| Future one-way dispatch-start | Evolution | CAS committed before lexical Baileys write |
| SERVER_ACK/delivered/read | APP reducer | Authenticated receipt evidence only |

APP uses CURRENT actor membership/policy, account/inbox/conversation/message
graph, writer epoch/binding, sender/instance lineage, identity, ownership and
quarantine when admitting and again when releasing. Historical receipt validity
never authorizes a new send. Existing BIA snapshot fields are compared for
authority loss; no BIA/takeover policy or switching is added.

## Wire contract derived from the existing Attendance boundary

APP initiates preparation and the new authority exchange. Evolution retains
the accepted foundation callbacks and authenticated prepared event outbox.
Admission and release are APP-local durable operations, not Evolution decisions.

| Request/event | Initiator | Receiver and effect |
| --- | --- | --- |
| `POST /nexi/attendance/prepare/:instanceName` | APP orchestrator | Existing Evolution preparation, stable preparation request UUID |
| Existing context/register-attempt/reserve/readback foundation requests | Evolution | Existing APP signed foundation services |
| `attendance.transport.prepared` | Evolution outbox | Existing APP authenticated intake/proof/reducer |
| `POST /nexi/attendance/authority/:instanceName`, `preparation_readback` | APP | Exact durable preparation, never allocates another candidate |
| Same endpoint, `consumption_readback` | APP | Original exact consumption, including after its deadline |
| Same endpoint, `consume` | APP | Exact released grant consumed once before deadline |
| `consumption_result` signed response | Evolution | APP validates and stores exact acknowledgment |
| `preparation_result` signed response | Evolution | Exact readback only; APP still waits for authenticated prepared proof |

The authority envelope is `{claims, signature}`. `claims` is unpadded base64url
of canonical_json_v1 bytes. HMAC-SHA256 signs
`attendance-authority:v1:<encoded claims>` with the EXISTING instance event key:
`HMAC-SHA256(master, "event:<instance name>")`. Preparation continues its
existing `attendance-prepare:v1` domain using the shared signing primitive.
The route also retains existing Evolution API authentication.

Claims bind version=1, protocol_version=1, canonical version, provider,
instance name/ID, UUID request ID, action, exact material, exchange expiration
and physical_dispatch=false. Audiences are `nexi-attendance-evolution` for
requests and `nexi-attendance-app` for consumption responses. Exchange lifetime
is at most 60 seconds. Renewing an envelope does not renew its grant/release.
No secret or signed body is logged.

Consume material contains `consumption_id`, `grant`, `grant_digest`, `release`
and `release_digest`. SHA256 uses the existing canonical JSON bytes. The result
binds that whole material via `request_digest`. Exact request, preparation,
attempt, reservation, external ID, grant and release IDs must agree.

The grant includes account/channel, execution/message/unit, attempt/reservation,
case-sensitive opaque external ID, preparation/content digests, authority digest,
instance/sender/session lineage, identity version, writer epoch/binding,
original admission request and expiration. Scope is `attendance_release_v1`;
physical_dispatch is false. Grant TTL is 60 seconds. Release carries its original
UUID/digest and is bounded by 15 seconds and the grant expiration.

## Admission, release, readback and replay

`AdmissionService.open!`, `decide!`, `resolve!`, `resolve_and_seal!` and
`release!` remain the authority foundation. `authorize!` connects current
authority and verified prepared proof to its original terminal decision.
Same request/material returns the original decision/grant. Changed material
under the same identity conflicts. Missing response/row means UNRESOLVED,
never NEVER_ADMITTED. Only a committed rejected/cancelled decision is negative
admission proof. Authority loss can persist a terminal negative decision using
downstream producer locks; that path cannot create a positive capability.

Release revalidates current authority after admission. An expired grant,
changed graph/identity/epoch/binding, paused channel or quarantine denies release.
Release replay returns the original terminal result; no response loss creates
a fresh grant or deadline. Consumption replay verifies the entire original
material even after expiry, while a NEW consumption or dispatch CAS requires
an unexpired released grant. Conflict fails closed, never replaces identifiers.

## Bounded orchestration and recovery

`ExecutionService` registers one orchestration row per manifest unit inside the
permanent ownership transaction. Registration adopts any original preparation,
admission and release request identities already committed before this slice.
`NexiAttendanceOrchestrationJob` runs every five minutes, registers at most 50
previous executions from a partial due index and enqueues at most 100 due units.
An atomic claim grants a 90-second lease. Backoff is exponential, capped at one
hour, with no recovery-count termination. At 12 recoveries the diagnostic becomes
`outcome_unresolved`; the same pending row remains scheduled indefinitely.
An accepted durable prepared proof makes its matching pending row due promptly.
Terminal units are excluded. No transaction/graph lock is held across HTTP.

| Durable state at restart | Recovery |
| --- | --- |
| A: execution, no attempt | Same preparation request, current APP authority required |
| B: attempt, no reservation | Exact preparation readback; existing Evolution foundation recovery reads original registration/reservation |
| C: reservation, no prepared proof | Readback/wait for existing outbox/proof; no replacement candidate |
| D: prepared proof, no admission | Open/decide original durable admission identity |
| E: admission response lost | Resolve/replay original decision, never another grant |
| F: admitted, no release | Revalidate current graph and commit original release |
| G: release response lost | Read original terminal release |
| H: release, consume response lost | Signed readback of exact consumption; only authenticated unresolved may retry that SAME operation before deadline |
| I: consumed, not started | End safely at READY_BUT_DISPATCH_DISABLED; hypothetical pre-write CAS also checks deadline/session/socket/recipient/material |
| J: dispatch-start, no result | Preserve UNKNOWN; no automatic resend, no reset |

HTTP 200 without accepted durable prepared proof does not advance admission.
Timeout, connection error, 404 and absent response are ambiguous. Only transport
chooses candidates. The accepted collision fencing is retained; candidate
replacement requires original durable definitively-not-sent proof. Admission
and release cannot replace an ID after a collision.

The collision predecessor/successor gap stays pending. Signed
`preparation_result.successor_chain` exposes only Evolution's committed
`successorId` / `requests.replacement` chain and registered successor attempt.
Each link binds predecessor preparation/request/attempt/external ID, the original
closure request, and successor preparation/request/attempt/external ID. APP
persists the append-only chain under its unchanged root preparation request.
APP and its SQL guard also require the predecessor's exact permanent
`close_collision` foundation result, no reservation/admission, and the successor's
exact execution/unit graph. No APP code chooses a successor candidate or request.
Lost APP collision-fence responses are recovered through the original foundation
readback and replayed closure identity; generic timeout cannot enter this path.

An attempt already UNKNOWN, dispatch-marked or transport-returned fences resend
but supplies no consumption acknowledgment. Its orchestration remains pending
and performs only the original signed consumption readback, without another
consume. Only the exact authenticated committed result with consumption and
dispatch-start timestamps can terminalize it as `outcome_unknown`. A temporarily
missing dependency, unverifiable response or authority exception is unresolved;
terminal denial requires durable cancellation, admission/release denial, immutable
ownership conflict, or signed unconsumed readback after release expiry.

## DB invariants and lock order

APP additive migration `20261006000004` adds only the orchestration table,
execution registration marker, recovery indexes and guards. Composite graph FKs,
unique unit/request identities, write-once acknowledgment, terminal transitions,
prepared admission proof and exact grant/release binding are enforced in SQL.
`DatabaseGuard.verify_authority_transport!` retains earlier checks and verifies
exact trigger wiring, FK/index/check definitions and pinned function bodies.
Promoted migrations 20261006000001/2/3 are unchanged.

APP positive decisions retain the accepted graph -> execution -> attempt ->
reservation -> correlation advisory lock -> admission order. Negative-only
fallback acquires downstream rows and never goes back upstream. Receipt
application cannot create an admission/release capability.

Evolution adds `20261006000000_attendance_release_dispatch` for PostgreSQL and
MySQL; accepted migrations are unchanged. It extends the existing preparation
row with exact grant/release/consumption material, unique identities and deadline.
Triggers protect immutable candidates, consumption, one-way dispatch and UNKNOWN.
CAS transactions check the actual catalog's pinned trigger/function definitions
and unique indexes. Storage or commit failure prevents dispatch eligibility;
there is no generic-send fallback.

The final correction guard pins the inherited APP admission/reservation CHECK
expression trees, 14 graph/lineage ownership FKs and 13 foundation/attempt/
reservation/admission/grant/release unique indexes. It checks ordered ownership
columns, tables, FK validation/actions/deferral, uniqueness, index method,
expressions, included columns, order, opclass/collation and exact partial
predicates. External-ID storage keeps its case-sensitive C collation. Foundation
and reservation retention/correlation trigger wiring and function bodies are
also pinned. No promoted migration changes.

Evolution certifies all five protected Attendance tables: permanent DELETE/
TRUNCATE guards, canonical immutability, preparation/outbox/consumption/dispatch
functions and trigger wiring (rejecting unexpected table triggers), validated state/canonical CHECK trees, primary
keys and original request/external-ID/source/grant/release/consumption uniqueness.
PostgreSQL must use origin trigger execution mode. MySQL/MariaDB additionally
requires InnoDB and exact binary identity columns, enforced CHECKs (including
MariaDB session enforcement), and both current-principal SHOW GRANTS forms.
DROP/ALL PRIVILEGES or other protection-altering privileges applying globally,
to the protected schema or table fail closed. Roles, proxy, dynamic or unknown
grant syntax also fail closed. A restricted runtime principal must be validated
at the final gate; ordinary non-Attendance Prisma paths retain their behavior.
See [MySQL SHOW GRANTS](https://dev.mysql.com/doc/refman/8.4/en/show-grants.html)
for the explicit-current-user versus mandatory-role distinction.

The corrected unpromoted MySQL INSERT trigger matches PostgreSQL's full initial
authority shape: draft, revision zero, outcomeUnknown false, and all twelve
admission/grant/release/consumption/dispatch-only fields NULL. This includes
grantDigest, releaseDigest, consumptionDigest, releasedAuthority and
authorityDeadline. Its effective body fingerprint is pinned by the guard.

## Physical boundary and unknown outcomes

`physicalDispatchEnabled()` is a literal false with no environment/admin override.
`releasedGrantCapability` never invokes its work callback while false. Even if
a future capability were deliberately enabled, the patched actual lexical
Baileys `sendNode` awaits `assertNode`, which commits `dispatchStart` CAS before
encoding and `sendRawMessage`. A second CAS cannot send. Foundation/raw/native
retry guards remain in place. This slice makes no managed physical write.

Dispatch-start immediately makes the result potentially UNKNOWN. Crash, socket
failure, missing ACK and transport return do not prove not-sent. A separate
transport return stores boundary evidence and retains UNKNOWN. SERVER_ACK is
never synthesized from sendNode resolution or HTTP success. The guarantee is
at-most-one automatic dispatch attempt after dispatch-start, stable readback
and no blind resend; it is not globally exactly-once delivery.

Legacy non-owned traffic retains existing behavior; permanent APP execution
ownership still prevents owned messages from falling back. The marker is not
authority. Slice 3 cutover and WriterBarrier remain unactivated.

## Offline validation and pending acceptance

APP: `ruby test/attendance/run_source_tests.rb` runs isolated source suites with
a network trap. Evolution: `node --require ./attendance-test-network-trap.cjs
--test attendance-authority.test.cjs attendance-canonical.test.cjs
attendance-corrections.test.cjs attendance-wave1b.test.cjs
attendance-storage-corrections.test.cjs`.

Shared `authority-v1.json` is produced in order by actual Evolution preparation,
actual Ruby APP ReleaseContract and actual Evolution consumption/signing. It is
copied byte-for-byte to both repos; its secret and identities are synthetic.
From Evolution in PowerShell, with the APP worktree path assigned to `$appRepo`:

```powershell
node fixtures/generate-attendance-preparation.cjs | ruby "$appRepo/test/attendance/release_producer_fixture.rb" | Set-Content -Encoding utf8 fixtures/attendance-authority-v1.json
node fixtures/generate-attendance-consumption.cjs
Copy-Item fixtures/attendance-authority-v1.json "$appRepo/spec/fixtures/attendance/authority-v1.json"
```

The real pinned Baileys 7.0.0-rc13 lexical sendNode body is separately extracted
with source path/hash in the test fixture and patched/executed with a fake raw
boundary; managed writes/encodes stay zero. No WhatsApp connection occurs.

Deferred final Wave 1C acceptance: real APP/Evolution migrations, Rails runtime,
both Evolution provider catalogs/Prisma bundles, real concurrent workers,
Redis/Postgres restart, actual outbox delivery, real MySQL/MariaDB runtime
principal grants and EasyPanel runtime. Full
snapshot/relay provider tests also need their installed patched Baileys/Long
dependencies. None of these are declared accepted by source checks.
