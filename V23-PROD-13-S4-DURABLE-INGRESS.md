# V23-PROD-13-S4 — durable ingress candidate

Historical S4 description. [S4-R1 corrections](V23-PROD-13-S4-R1-CORRECTIONS.md)
supersede its cancellation, continuation and retention behavior and document
the held legacy integration contracts before any promotion.

Evolution base: `3561c85b608d99b22c0c625395837a98c49a205f`.
Compatible APP base: `232a3f635e8baaa03879f82a9c7c4eebdedebf37`.
Candidate branch in both repositories: `candidate/v23-prod-13-s4-durable-ingress`.

## Implemented path

1. The pinned Baileys `CB:message` path authenticates and decrypts the stanza.
   The existing PN/LID observation checks are preserved, including exclusions
   for history, offline imports, protocol/edited messages, peers, groups and
   messages from self. No cache or telephone equivalence supplies identity.
2. Before the existing delivery receipt, the live observation transfers through
   `identity.transferToIngress`. This function requires the decoder-owned
   message object in its private WeakMap. It never restores that map from JSON.
3. `nexi-ingress.cjs` validates the exact socket owner against the database and
   the credential fingerprint, resolves the configured account/inbox, and
   commits a recovery record containing original protobuf bytes and the exact
   Baileys key extensions (including `remoteJidAlt`/`addressingMode`, which
   WAProto alone would discard), plus a signed envelope. The envelope
   binds provider, account, inbox, instance name/ID, session, external ID,
   authenticated observation, complete recovery-record SHA-256, acceptance time and journal UUID.
   Its key is HMAC-derived with `ingress:v1:<instance>`, distinct from event and
   writer domains. APP independently verifies the envelope.
4. A scope CAS allocates a durable sequence and enforces capacity in the same
   transaction as the journal and conversation lane. Only after commit can the
   original callback skip its old serial handler. A coalesced wake starts work;
   a five-second periodic sweep recovers pending rows after reconnect/restart.
5. Workers decode the persisted protobuf, apply the pinned `cleanMessage`, and
   invoke the existing per-message handler with a private execution context.
   The context supplies a verified observation without manufacturing a live
   WeakMap capability. Existing content/media conversion remains in that handler.
6. Identity observation, Chatwoot creation, correlation, and the handler's
   continuation execute outside `eventProcessingQueue`. Each confirmed main
   stage checkpoints in the database. Local Message persistence uses the
   journal UUID as an idempotent ID. Success atomically decrements scope/lane
   pending counters.

## Scheduling, ordering and pressure

- Four workers per process, at most two per instance; one active lease per
  conversation. There is no memory queue containing uncommitted messages.
- Provider/account/inbox/instance scopes rotate; within an instance lanes use
  least-recently-served order. A slow conversation does not occupy every worker
  of another instance. A lane's earliest unfinished sequence owns its order,
  including while its head is backing off or held for reconciliation.
- Lane identity uses authenticated PN within its exact session and scope. This
  is a queue key, not a new PN/LID equivalence or physical-send destination.
- Leases last 60 seconds, renew every 20 seconds, and use token CAS for all
  checkpoint/finish/release writes. Recovery waits for lease expiry. Socket
  registration captures the original owner; configuration copies inherit that
  registration. Old callbacks cannot adopt the replacement socket.
- A scope admits at most 10,000 unfinished rows, with at most 1 MiB per
  recovery record (including encoded protobuf and key sidecar).
   Capacity, payload-size, binding or storage failures close the exact
  current socket and raise a visible admission failure before the normal
  delivery receipt. No success acknowledgement substitutes for a commit.
  Transport redelivery after an admission/storage failure is not guaranteed by
  this candidate; the failed admission must be investigated as such.
- New arrivals do not reset an existing lane's backoff. Recoverable retries
  use exponential backoff with jitter, capped near five minutes. Metadata
  requests time out after ten seconds, SDK message creation cancels after
  fifteen seconds, and multipart creation has a fifteen-second timeout.

## APP contract and uncertain creation

Signed events use the existing webhook and outer event HMAC:

| Event | Operation |
| --- | --- |
| `ingress.observed` | Validate durable proof and reserve an exact authenticated source |
| `ingress.reconcile` | Under the Message writer's owner locks, return the pinned result or `absent_retry_safe` |
| `ingress.correlated` | Validate exact ACK and run the existing identity correlation/capture |

The APP admission has unique journal UUID, unique evidence, and unique
channel/session/external-message scope. A database trigger makes its proof
binding and confirmed Message ID immutable. A foreign key preserves the pinned
Message. `WhatsappInboundCreation` records the admission's Message ID in the
**same transaction** as Message persistence, before its HTTP response. The
existing source/association, ancestor, generation, sender and inbox checks stay
in force. Missing ingress guards fail closed.

Repeated external IDs must preserve the authenticated PN/LID and protobuf
message-content digest. Conflicting identity/content closes intake visibly;
delivery timestamps or presentation names do not replace the first payload.

Every worker creation attempt first reconciles. A lost response is never
interpreted as absence. The worker reconciles again after the call and only
checkpoints an APP-confirmed result. If reconciliation is unavailable it keeps
the row pending/uncertain and backs off. If absence is confirmed, a later POST
can be retried because both an old delayed POST and its retry must pass the same
transactional source reservation; they return the same Message. This guarantees
an idempotent Message effect, not exactly one HTTP request or attachment upload.

Stable event IDs are derived separately for each stage and immutable ACK body;
HTTP authentication timestamps are refreshed. Durable evidence does not expire
at the legacy fifteen-minute limit, but recovery must match the live APP
session. It cannot install or resurrect a session. Legacy identity events keep
their old expiry and attempt-UUID rules.

## Explicit uncertainty and retention

States are `pending`, `succeeded`, `recoverable_failure`, `result_uncertain`, and
`outcome_unknown`; `checkpoint` and `lastError` identify the stage/reason.
The journal never queries or retries old physical preparations in
`outcome_unknown`.

The legacy handler continuation includes optional speech-to-text, object
storage, generic webhooks, chatbot callbacks and contact synchronization. It
does not provide one end-to-end idempotency contract. This candidate persists
`continuationStartedAt` before entering it. A crash/error there is held as
`outcome_unknown`, with payload retained, and is **never automatically replayed**.
Existing socket controls before that continuation have individual persisted
attempt/confirmation records; uncertainty also holds the lane. This trades
automatic continuation recovery for preventing duplicate physical/legacy
effects. It does not undo a confirmed Chatwoot Message or its correlation.
Resolving such a hold requires proof of the missing effect, not resetting its
state to `pending`. Until resolved, later messages in that conversation wait;
other conversations remain eligible.

Successful Evolution rows/payloads and idle lanes expire after seven days,
checked hourly. Unresolved payloads are not automatically deleted: the admission
capacity is the storage/backpressure bound. APP source reservations retain only
small proof/deduplication metadata and the Message reference, with no raw
protobuf. A retransmission after local retention cannot replace that APP
reservation with a new UUID; it fails closed instead of recreating history.
Rows fenced by a replaced session remain held for explicit reconciliation.
Secret rotation while rows are pending requires retaining/verifying the old
ingress key through a separate key-rotation change; silently resigning old
payloads is unsupported.

`ingress.admission_failed`, `ingress.worker_pending`, `ingress.outcome_unknown`,
`ingress.recovery_pending`, and `ingress.retention_pending` expose failures with
journal/instance IDs and reason codes, without payload or recipient logging.
S1/S2 trace budgets/markers remain; decoded worker messages receive a diagnostic
span marked `durable_ingress`, with persisted wall-clock queue age and fresh
monotonic handler timings. Pre-restart receive timings are not invented.

## Deployment dependencies — not executed

1. Apply APP migration
   `20261015000000_create_channel_whatsapp_ingress_admissions.rb` in a later
   authorized deployment (PostgreSQL; existing identity/successor guards remain
   prerequisites). Deploy this APP candidate before enabling Evolution S4.
   The new APP still accepts the old Evolution identity events.
2. Apply Evolution migration `20261015000000_nexi_durable_ingress` for its actual
   database provider. PostgreSQL and MySQL SQL files are versioned;
   `psql_bouncer` uses PostgreSQL migrations as before.
3. Build/deploy the Evolution candidate later. The Dockerfile applies the new
   patcher after S3 and adds the journal models before Prisma generation. It
   ships the single external CJS helper to avoid split execution contexts.
4. Preserve the shared event master secret and existing verified binding.
   Existing account/session proof and physical writer activation are still
   mandatory. No new ingress flag grants writer permission.
5. Do not roll the APP back while S4 workers remain active. A coordinated
   rollback must retain journal and reservation tables and reconcile unfinished
   work; disabling the journal and blindly replaying its rows is unsafe.

## Preserved boundaries and concrete limits

No writer release/admission/CAS, WriterBarrier, physical dispatch, financial
recipient, outbound reservation, or receipt-normalization code was changed.
No SERVER_ACK, DELIVERY_ACK or READ was synthesized. The journal signature
cannot be submitted as a physical writer grant. The per-worker Chatwoot
provider field uses AsyncLocalStorage; legacy calls keep their existing field.
Quoted-message lookup is now instance-scoped in the Chatwoot handler.

S3 photo RPC removal, immediate/coalesced outbox wake and periodic outbox
recovery remain. Photo refresh could use a separate bounded presentation queue
with session/generation fencing, but is not implemented and cannot rejoin the
ingress critical path.

The journal covers messages accepted by the existing live direct-message
authentication boundary. It does not turn historical imports, offline append,
group traffic or unauthenticated events into identity proof. Media conversion
still depends on the original media remaining available. Optional legacy tail
operations can occupy a worker until their own call completes; their uncertain
effects require manual reconciliation as described above.

Only targeted static source/diff/anchor review was performed. No local tests,
parser, lint, build, migration, infrastructure access, deployment or real send
was performed. The 2–3 second operational target has **not** been measured.
