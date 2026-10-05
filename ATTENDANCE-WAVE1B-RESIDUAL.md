# Wave 1B final residual correction: W1B-DELTA-01

Source scope: immutable encoding input, encoded-semantic provenance, immutable
final-frame validation/transmission, related tests/assertions and documentation.
No APP contract, migration, receipt, outbox or canonical format change.
W1B-02 and W1B-03 stay closed. No merge, promotion, deployment, production DB
operation, 1C implementation or managed Attendance dispatch activation.

## Verified source state

APP clean local/remote feature: `8584a772581f9d4d0fe2f635decbe133b78e613a`.
Deploy: `94a8905d586e1156ddefe04fac9def8ebfcb171b`.
Evolution clean local/remote feature start:
`240dc96d0254f3f18acdd5580ec13caeb4c03de1`; main:
`334b9119030aec6c9241fd8fe878d03aceef83cc`.
Exact upstream: `e273b904d53f5726970fd6a244ed9caa61dfeb9a`;
Baileys `7.0.0-rc13`, accepted package-lock integrity.
Evolution stays on `feature/nexi-attendance-wave1b-boundaries`; APP untouched.
Implementation commit: `f6756384c68a3bb96ab89a885944d6a6b6d55ec0`.

## Root cause and corrected byte chain

Previously, relay async callbacks/device lookup could read the original message
before late bindStanza classification. Mutate-and-restore could make ciphertext
and the later fingerprint refer to different semantics. Final sendNode awaited
assertNode and then encoded the original mutable frame, allowing another TOCTOU.

Now: synchronous private relay snapshot -> purpose classified -> private callback
working copy -> immutable callback-result snapshot -> classification of the
exact material passed to the synchronous protobuf encoder -> private bytes ->
encryption -> completed stanza with semantic provenance -> synchronous private
frame snapshot -> asynchronous assertion of that snapshot -> encoding of the
same snapshot -> private noise/socket bytes. Caller references never re-enter
the pipeline after capture. This is isolation, not another before/after hash
of a caller-owned mutable reference.

## Semantic snapshots and type preservation

`nexi-attendance-snapshot.cjs` copies recursively before any yield. Ordinary
arrays/objects are frozen after isolation. Null/undefined, array order/holes,
strings, finite protobuf numeric values (including float), booleans and own
protobuf fields retain their semantics. Exact installed generated protobuf
prototypes are allowlisted through the trusted module, with their own fields
copied into encoder-compatible structures. Installed Long low/high/unsigned
and methods are preserved without JS safe-integer conversion. This local
protobuf domain is deliberately separate from unchanged canonical_json_v1.

Buffer/Uint8Array payloads are copied privately. Frozen graph properties expose
fresh byte views backed by closure-private original bytes; obtaining/mutating
a view cannot change the next encoder read. Nonempty typed arrays are not
falsely claimed immutable through Object.freeze. Caller objects are never
frozen. Callback working copies are writable to preserve Evolution's existing
list-type normalization; their returned material is copied again before encoding.

Reject cycles, accessors/custom structures, nonfinite numbers, unsupported types,
symbols/non-data properties and excessive input. Local snapshot ceilings:
depth 64, 65,536 visited values/keys, 16 MiB aggregate strings/keys/binary data;
array length is also bounded. These are explicit transport-input safety limits,
not invented receipt production configuration. Inline protobuf metadata and
thumbnails are copied; media upload streams/files are outside this completed
relay message boundary and are not cloned. Failure logs bounded reason IDs and
fails closed; no mutable fallback, new configuration switch or send permission.

## Encoded material and PDO provenance

The pinned PDO constructor now registers/returns its own immutable snapshot,
never its mutable original. Only that exact WeakMap identity can transfer its
proof to the private relay root for the same config/socket, authenticated
session and own recipient. Equivalent JSON or another clone has no proof.
Existing bounded subtype-4, incoming-direct-placeholder allowlist is retained.

Every plaintext encoding site uses encodeMessage: participant messages,
newsletter, group encryption, explicit retry/DSM and reporting-token material.
Each consumes an immutable encoding snapshot. The private relay record joins
actual encoded purposes conservatively: edit/customer-affecting or unknown
cannot be downgraded by later participants. Internal exemption additionally
requires every encoded semantic value to match the registered snapshot;
the narrowly recognized own-device DSM envelope is unwrapped for that exact
comparison. A changed callback result, another subtype, recipient, session,
socket or absent encoder record loses internal proof. Cryptographic fanout may
vary; the semantic root and revision cannot vary through caller aliases.

The local semantic fingerprint supports protobuf/binary/undefined and only
joins private snapshots. It does not replace or alter APP canonical digests.
Finite numbers use explicit IEEE-754 binary identity, including negative zero.

## Final frame and every async boundary

sendNode synchronously snapshots tag, attrs, children and binary leaves before
its first await. Purpose proof transfers only if config and full completed-frame
fingerprint match. assertNode, logging and encodeBinaryNode use `nexiFrame`.
No encoding/logging reads the original frame after validation. Altering a
non-message into a message, or changing ID/to/participant/content/attrs after
entry, affects only the discarded caller reference.

| Await/yield in pinned path | Retained material / mutation protection |
| --- | --- |
| sendMessage generation/upload/link preview before relay | Complete generated semantic value is captured on relay entry; high-level input is not final authority |
| authState.keys.transaction admission/mutex | Relay message/options already private and frozen |
| cachedGroupMetadata/groupMetadata/keys.get/getUSyncDevices/assertSessions | Caller message, participant, attributes/nodes/status list already captured; lookup results remain transport-owned |
| reporting/per-device/group/newsletter patchMessageBeforeSending | Callback receives private writable copy; result captured before encoder, never classified from original |
| encryptionMutex and encryptMessage/encryptGroupMessage | Bytes were synchronously encoded from classified immutable material; no caller references |
| Promise.all participant fanout | Same private root and purpose record; each actual encoder captured/classified |
| hasSenderKey/getSenderKeyDistributionMessage retry reconstruction | Original retry message/options already captured; reconstructed material passes same encoder hook |
| getMessageReportingToken/resolveTcTokenJid/token keys.get/keys.set | Private semantic inputs and transport-created stanza; additional caller nodes already copied |
| final assertNode durable preparation lookup | Final frame copied before await; caller mutations irrelevant |
| sendRawMessage/promiseTimeout/WebSocket send | Binary node and noise frame already encoded into transport-private bytes |
| Post-send token issuance/retry-cache work | Cannot retroactively change transmitted bytes; no new retry grant |

Callback results are explicitly re-snapshotted rather than assuming trusted
callbacks never retain references. Authentication/session observations are
server-owned; internal proof is checked again at final assertion.

## Source re-attack and preserved domains

* A: edit mutated during callback/encryption and restored before bind -> encoder
  consumes initial/private result only; actual edit remains physically denied.
* B: original PDO transiently changed to history before encoding and restored
  before bind -> immutable subtype 4 is encoded; no mutated content exemption.
  A callback that actually substitutes history clears internal proof and is denied.
* C: sendNode original IQ mutated to customer message while guard yields -> only
  captured IQ bytes are sent.
* D: validated message original ID/to/participant/attrs/content replaced -> only
  validated snapshot bytes are encoded; prior proof cannot transfer to changed bytes.
* E: nested Buffer/Uint8Array or returned snapshot view mutated -> private binary
  backing remains unchanged.

All structured sendNode callers inherit final snapshot enforcement. HTTP/API,
WebSocket service and voice message-node raw boundaries remain installed.
Opaque raw bytes retain existing managed/ambiguous denial, not semantic parsing.
Native retry/reconstruction uses the same relay encoder/final gate. Non-managed
legacy valid protobuf/binary output stays equivalent; its inputs are not frozen.
Groups lifecycle/ownership/retry/relay guard and financial exact recipient,
signed authority/invoice freshness/native retry guard remain unchanged.
Attendance foundation_only/ID-prefix/durable-preparation denial remain unchanged;
snapshot/PDO markers cannot grant dispatch. No invoice_url activation.

## Pinned and actual artifact proof; tests

All new patch anchors use exact cardinality 0/1/>1 and all anchors validate before
any patch write. Financial/trusted/Groups/Attendance layer order unchanged.
Shipped assertions inspect installed Baileys: snapshot before relay await,
all five plaintext encoder hooks/four callback hooks, immutable PDO construction,
final frame before assertNode, and encoding/logging only nexiFrame. They continue
checking ERROR capture order, canonical helper/corpus, Groups/financial hooks
and physical dispatch denial. Docker includes the snapshot helper in final image.

`attendance-snapshot.test.cjs` extracts actual installed lexical relay and
sendNode bodies, uses the installed protobuf/Long and binary codec, and supplies
controlled transport/DB/crypto stubs. Deferred barriers pause before encoding,
during encryption and final validation. Tests cover transient/restore attacks,
nested bodies/binary, ID/JID/attrs/children mutations, copied/callback-substituted
PDO, managed/ambiguous denial, legacy exact bytes, protobuf/Long equivalence,
snapshot bounds, wrong socket/session/recipient, participant fanout with retained
callback references and Groups/financial/foundation denial.
Existing corrections tests now model real immutable registration/encoding.
Source-anchor mutation tests reject zero/multiple anchors without partial writes.

PROJECT TEST SUITES NOT EXECUTED LOCALLY —
EASYPANEL IS THE DESIGNATED BUILD/RUNTIME VALIDATION ENVIRONMENT

Only node --check, Git diff checks and source inspection ran on Serra. EasyPanel
must run the new async attack tests, both provider builds/final assertions and
socket compatibility checks. Source completeness does not claim runtime success,
Wave 1B acceptance or exactly-once delivery.

W1B-DELTA-01 — CLOSED BY IMPLEMENTATION

NEXI ATTENDANCE WAVE 1B FINAL RESIDUAL CORRECTION IMPLEMENTED —
READY FOR FINAL STRICT DELTA SOURCE REVIEW
