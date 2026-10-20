# S12 — single-operation lane under global HOLD

Status: candidate implemented; physical NO-GO. See S12-ISOLATED-DISPATCH-REPORT.md
for final validation, remaining gates and the operating procedure. No runtime operation
is authorized by this document. No physical send, deployment, real creation,
queue mutation, migration, authorization revocation or external VPS access.

## Canonical sources and source findings

- APP `9665d1a52a76b00e9449b9d346841df324fa89e2`, clean local/remote candidate.
- Evolution `b206baaa0518ba881fade671942a693ca1c24188`, clean local/remote candidate.
- New branches in both repos: `candidate/v23-prod-13-s12-isolated-dispatch`.
- APP separate worktree: `tmp/app-s12-isolated-dispatch` (required by AGENTS.md).
- Evolution workspace: `tmp/evolution-v23-prod-13-s12`.

The existing HOLD fences APP admission, release, prepare control, orchestration,
recovery and writer activation; Evolution fences consume, probe, dispatch and
the final lexical sendNode boundary. Releasing it is channel-wide and therefore
cannot isolate one execution. Recovery under HOLD deliberately selects only
receipt/correlation work and never commercial orchestration or backfill.

`ManagedChannelWriterBarrier#dispatch_enabled?` compares the activation's
`evolution_proof.receipt_context` to WriterBarrierService.receipt_context(channel):
instance lineage for the external instance, latest sender attestation for the
current session, sender account lineage and attestation ID. A newer attestation,
session/instance rebind, old manifest or mismatched channel binding can invalidate
it. Equality must not be overridden. A new authenticated fencing/probe/activation
must prove the current receipt socket and context; no old manifest is edited.

`ManagedChannelDispatchAuthorization#current_for?` has no TTL: it checks only
revocation, active account, binding and current administrator membership. This
explains why the old October 11 authorization can remain effective. It will not
be read as authority by the new lane, reused, consumed or revoked by this work.
Supported later revocation must remain audited and separately authorized.

## Chosen architecture

Keep commercial workers and recovery unchanged/held. Add an opt-in,
default-disabled authorization for ONE new human text execution (one transport
unit, no media, reply, automation or existing execution adoption). Dedicated job
receives a specific orchestration/authorization ID, never a channel scan. It
uses the existing WorkQueue lease/CAS and existing orchestrator, prepared proof,
admission/release, consumption and irreversible dispatch-start.

Authorization must be a new durable APP record with immutable canonical
binding, manifest/payload digests, planned execution/request UUIDs, administrator,
anchor incoming message, approval time and maximum five-minute lifetime. Bind
account/channel/inbox/conversation/contact/ContactInbox, verified identity slot
and version/generation, PN recipient digest, instance and sender lineages,
session, binding generation and the newly fenced writer epoch. A unique
authorization-to-execution link is consumed atomically with Message/execution
creation; retries return that same operation. No caller-supplied phone/text-only
exception. No adoption of old created/pending/outcome_unknown executions.

Use Authority.with_message(outgoing_required:false) on an authenticated verified
incoming anchor for preview/approval. This avoids weakening/refactoring the
existing authority lock graph. The owner must separately prove the canonical
recipient digest/version against runtime identity evidence. UI DDD/last digits
are insufficient. Content is frozen through OutboundManifest, one text unit.

A NEW `isolated_operation` writer activation references that authorization,
never ManagedChannelDispatchAuthorization. Normal dispatch_enabled? must remain
false for that activation mode. Add isolated readiness validation retaining all
receipt, socket, session, channel and manifest checks. Existing writer probe is
extended only for a signed, valid, expiring operation token while HOLD stays true.
Fresh activation fences epochs; it must not borrow the old effective consent.

Transport context optionally carries a signed `isolated_operation` token only
for that activation and consumed new execution. Its physical capability is
scoped by the token, never globally usable. Old contexts remain unchanged. All
HOLD escape points require the same frozen token and its execution/unit/recipient
binding. Native/unscoped/backlog sends remain denied. At dispatch-start the fresh
context must carry the SAME token and binding; an ordinary true capability is
insufficient. Existing grant/release deadline must be capped by authorization
expiry, checked again by database-clock dispatch CAS. After CAS any ambiguity
remains unknown/readback-only; no second physical attempt is inferred.

`NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED` must be literal true in BOTH APP and
Evolution for this lane. Default false. It cannot replace owner approval. When
enabled with HOLD=true, Evolution's old boot-release file must NOT release the
global HOLD. All old code paths still see held=true. Removing HOLD is forbidden.

The token is nested INSIDE existing HMAC prepare/context/grant envelopes, never a
browser bearer credential. Retain existing scope `attendance_dispatch_v1` plus
the strict additional property. Old Evolution rejects the extra key. New code
requires exact token keys, lifetime <=300 seconds, canonical digest equality and
one text unit at all boundaries. Normal grants cannot inherit scoped authority.

## APP storage changes required by this design

New append-preserving isolated authorization table: immutable binding/manifest,
planned execution/request UUIDs, approve/expire times, optional one-way consumed
message/execution/time and audited closure. Unique planned execution, request
and active channel ownership. Do not mutate old authorization tables/records.

Existing PostgreSQL activation and send-proof guards accept ONLY managed_channel
activations backed by the old consent. Therefore Ruby-only exceptions are
incorrect. Add isolated-specific guard functions validating the new record,
exact binding and consumed execution. Extend activation shape and the two known
functions with strict source anchors, preserving all old predicates. Add exact
fingerprint/catalog gates; do not accept arbitrary or mixed guards. Existing
Evolution storage triggers/CAS can remain unchanged if the extra grant token is
covered by the existing immutable signed material/digest; verify this explicitly.

For safe rollout, new APP can accept the exact known old/new common guard
fingerprints, but isolated entry points MUST require the new schema/guards.
This permits new APP before local migrations without disrupting normal ingress.
No rollout is performed here. No down migration discards authority evidence.

## Implementation status

The validators, durable APP authorization/guards, approval/preview/create API,
scoped writer activation, prepare/grant/context integration, dedicated capsule,
existing consume/CAS boundary and targeted recovery are implemented. Security,
crash/concurrency and backlog tests run against the real local SQL/services and
the patched mocked physical boundary. See the final report for exact outcomes.

No sender is invoked outside the existing protocol. Remaining requirements are
full Rails/image CI, runtime canonical identity/receipt validation and separately
authorized owner action. Publication is candidate code only, never physical GO.
