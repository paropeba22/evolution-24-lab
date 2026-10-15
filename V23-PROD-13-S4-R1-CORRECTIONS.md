# V23-PROD-13-S4-R1 — corrective implementation

Status: **PARTIAL — SPECIFIC BLOCKER** for promotion with all legacy integrations
enabled. Cancellation and the independent durable secondary mechanism are
implemented. Generic legacy dispatchers remain explicitly held because their
completion/idempotency contracts do not allow safe execution and recovery.

Direct parents, verified against the remote S4 branches before work:

- Evolution: `30cb4b7453633d0730f11fc0444920bcb21acd0b`.
- APP: `44dfa6a2167f8c7dd8c3e1870455715a9fa7b8a1`.
- Corrective branch in both repositories: `candidate/v23-prod-13-s4-r1-stabilize`.

## Chatwoot duration and capacity

The exact upstream lock pins `@figuro/chatwoot-sdk` **1.1.17** and its nested
Axios **0.27.2**. `Messages.create` returns the original `CancelablePromise`.
Its cancellation handler calls `CancelToken.source().cancel()`, but the public
promise rejects immediately, before the asynchronous request executor settles.
Waiting only for that public rejection would release capacity prematurely.

`patch-chatwoot-completion.mjs` verifies both installed/locked versions and
normalized SHA-256 of `Messages.js`, `CancelablePromise.js` and `request.js`.
It adds a never-rejecting `nexiTransportSettled` promise, resolved in the actual
request executor's `finally`. Docker ships the patched external SDK, including
its nested Axios, into the final image. It is not only patched in the builder.

At 15 seconds, ingress requests the supported cooperative cancellation. It then
waits for **both** public settlement and executor completion. The main worker
slot and renewing lane lease remain occupied until then. There is no
`Promise.race`. If a different promise lacks this verified tracking/cancel API,
the deadline records `awaiting_real_completion` and waits for the real operation;
it cannot claim a hard duration bound. A permanently stalled transport can
therefore consume a bounded worker slot indefinitely. Cancellation also cannot
prove that the remote Rails transaction stopped or that no message was created.

After any return/rejection, the existing signed `ingress.reconcile` contract
resolves the APP reservation. A later attempt reconciles again before creation.
Only `absent_retry_safe`, under the APP's existing source/owner locks and atomic
reservation-to-Message binding, permits a new POST. A pinned Message ID is reused;
conflicting IDs fail closed. An unavailable reconciliation leaves durable pending
work. Timeout is never proof of absence. This provides the idempotent effect
supported by that APP contract, not exactly one physical HTTP execution.

## Main materialization and individual effects

The main lane now requires authenticated observation, APP association, confirmed
Chatwoot creation, correlation and the mandatory local Message. In one database
transaction it validates the lane lease and current instance socket-owner CAS,
upserts the local Message at the journal UUID, creates individual signed effect
intents, and persists `mainMaterializedAt`. Local persistence is mandatory for
this path even when the legacy optional message-save setting is disabled.
`finish` checks the same local/Chatwoot identity before releasing the main lane.

The old monolithic tail is skipped only in this journal worker. Existing handlers
outside the journal keep their legacy path. Later messages in the conversation
cannot pass an earlier main requirement. They can pass independent secondary
uncertainty after the earlier main transaction and final checkpoint succeed.
Chatwoot attachment preparation/creation remains mandatory: unavailable media
needed to materialize that original message can still hold its main lane.

| Individual intent | Execution and recovery |
| --- | --- |
| `projection` | Local scoped chat projection; recomputes unread count from persisted statuses instead of repeating counter increments. |
| `contact_projection` | Local scoped contact upsert; preserves the stored photo without a photo RPC. |
| `transcription` | Independent per-message external attempt; checkpoints real text before merging into the original local Message. |
| `media_archive` | Independent per-message download/archive; stable journal/operation object path, verified upload `etag`, original local Media/Message target. |
| `read_control`, `history_control`, `placeholder_control` | Existing policy/literal controls, exact captured socket, durable pre-attempt marker, no automatic uncertain replay. A transport return does not fabricate a delivery/read receipt. |
| `message_webhook`, `chatbot`, `contact_webhook`, `contact_chatwoot`, `chat_name_webhook`, `contact_cache` | Intent only, `blocked_contract`; no dispatch. See blocker below. |

Each operation has a stable UUID, unique `(journalId, kind)` and `(laneId,
sequence)`, plus HMAC `ingress-effect:v1:<instance>`. The proof binds original
source digest, journal, operation/kind/lane, instance, session, exact local and
Chatwoot Message IDs and selected policy. This is ingress evidence, never a
physical writer capability. PN/LID equivalence is not inferred.

Secondary work uses its own pool: maximum two executing operations per process,
one per instance, rotating instance selection and least-served lanes. Separate
leases last 60 seconds and renew every 20 seconds without overlapping renewal.
The existing primary pool remains four per process/two per instance. These are
per-process limits, not a global rate limit. A scope caps runnable secondary
intents at 10,000; capacity exhaustion rolls back main materialization and leaves
the journal for retry. Held audit intents do not consume runnable quota.

For a conversation, each effect family has an ordered lane. Unknown execution
holds only that family's later dependent effects as `blocked_dependency`.
Transcription and archive lanes additionally include the journal ID, so a pending
attachment cannot stop a different message's independent supplement. The main
lane, unrelated families and other conversations remain eligible.

## Checkpoints and interrupted work

- States distinguish `pending`, `inflight`, `result_confirmed`,
  `recoverable_failure`, `succeeded`, `outcome_unknown`, `blocked_contract` and
  `blocked_dependency`. A durable `inflight` intent precedes external invocation.
- A confirmed returned result is persisted before local application. After a
  failure in local application, only that local merge is retried, retaining the
  same Message ID. Media supplements do not create another Chatwoot message or
  invent missing content.
- Local transactional projections are repeat-safe and use exponential backoff
  capped at five minutes. External rejection or interrupted `inflight` is
  uncertain; without a truthful reconciling adapter it is never physically
  repeated. A result too large to checkpoint is also uncertain, not successful.
- A five-second recovery sweep and coalesced wakes service both pools. Slots
  remain occupied while their actual awaited operations are running. Storage
  failures are logged and keep durable work recoverable.
- Existing S4 `continuationStartedAt` rows may release their main lane only after
  APP reconciliation confirms their previously recorded Message ID and mandatory
  local materialization succeeds. Their individual tail effects, including a
  `legacy_tail` marker, remain `outcome_unknown` without replay. Precisely known
  pre-tail control uncertainty is similarly separated and durably identified.
  Other unknown main outcomes, fences and invalid proofs stay held.
- After seven days, completed main records with no active secondary jobs lose
  their raw payload and large results. Signed dedup/audit metadata, intent states
  and result digests remain. Duplicates hit this tombstone, never a new creation.
  Active jobs keep their exact payload. Small tombstones and blocked/unknown
  metadata are retained indefinitely; automatic replay/deletion is not a policy
  for resolving them. Retention processes finite batches with event-loop yields.

## Specific blocker and functional limitation

The generic event/webhook adapter retries POST internally and can swallow final
failure. `ChatbotController.emit` returns while multiple integrations are still
running. These APIs do not provide truthful awaitable completion, an accepted
stable operation ID, a durable result or safe reconciliation. Invoking them and
calling them complete would again release execution capacity while hidden work
continues. Invoking them after restart could duplicate physical effects.

Consequently the generic fanout families above are **not executed for this new
journal path**, including new messages. Their intention is visible as
`blocked_contract`; previously attempted S4 tails remain uncertain. This is a
functional deferral, not successful delivery of webhooks/chatbot/cache updates.
They do not block primary Atendimento reception. Promotion requiring those
features still needs dedicated awaitable adapters with operation identity,
downstream dedup/result lookup and explicit resolution of already uncertain
operations. There is no generic force-retry API. No BIA/n8n code was changed and
no new physical-send authority was added.

## Directed composition corrections and preserved guarantees

The old S4 bare `await decrypt()` anchor matched both branches introduced by the
groups patch. Capture now matches exactly the direct-message decrypt branch,
leaving the groups transaction unchanged. Failed ingress admission is tagged,
closes its exact owner and bypasses the generic ACK/NACK fallback. Protobuf
content is checked before `cleanMessage`, and authenticated PN/LID key extensions
are restored. Media reupload uses the captured socket rather than a replacement
`this.client`. The quoted-message lookup remains instance-scoped.

S1 instrumentation, S2 event buffer changes, S3 photo-query removals, coalesced
outbox wake and periodic recovery remain in the patch composition. WriterBarrier,
writer CAS/HMAC/fences, outbound `outcome_unknown` and real receipt requirements
are unchanged. Photo refresh stays deferred; a future photo adapter must have
its own independent bounded queue and must never reenter the main ingress lane.

There is **no atomic transaction between Signal state and PostgreSQL journal**.
Capture follows authenticated decryption; a process/storage failure after Signal
state advances and before journal commit remains an architectural recovery gap.
Closing admission avoids a false success receipt but does not prove redelivery.
The cryptographic transactional R0/R1 design is outside this corrective change.

## Migrations and later deployment order

New Evolution migration: `20261015000001_nexi_ingress_secondary` for PostgreSQL
and MySQL; psql_bouncer uses PostgreSQL. It adds main/payload/legacy-control
checkpoints, secondary counters and separate intent/lane tables. No migration
was executed. No R1 APP code/schema change is required: its S4 admission,
immutable confirmed Message binding, guards and three signed endpoints remain
prerequisites. The APP corrective branch records this compatibility contract.

For a later authorized rollout: retain/complete the S4 APP migrations and code;
quiesce **all** S4 Evolution ingress workers; apply the provider-specific R1
Evolution migration; start the coordinated R1 runtime containing the patched SDK
and generated client. Do not mix S4/R1 workers or roll back to S4 while R1 intents
are outstanding: S4 ignores the new main checkpoint and could enter its old
monolithic tail. This document is not a deployment action or migration execution.

## Verification performed and its limits

Directed static review and `git diff --check` were used. One short finite offline
check, `verify-ingress-r1.mjs`, used exact pinned upstream/SDK files and TypeScript
6.0.3; fixes were reapplied to that fixture. Its five checks passed:

1. Full source-patcher composition through S1/S2/S3/S4-R1, decrypt/receipt order,
   generated TypeScript syntax and captured-media-socket anchors.
2. Actual SDK `Messages.create`/`CancelablePromise` with fake Axios: public cancel
   rejects while the worker remains waiting until the HTTP executor settles.
3. Native promise fallback waits for actual completion after deadline.
4. Individual stable intents, dedup and conservative old-tail classification,
   with no dispatch during intent planning.
5. Mandatory local materialization checks the same confirmed Message ID and
   plans secondary intents without dispatch inside that transaction.

No live database, migration, network message, application startup, build,
typecheck or long test suite was run. These checks do not validate SQL execution,
production timing, remote cancellation or downstream idempotency. The operational
2–3 second goal has not been measured or declared achieved.
