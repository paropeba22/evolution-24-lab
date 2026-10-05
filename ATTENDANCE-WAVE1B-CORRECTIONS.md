# Wave 1B strict source review corrections

Scope: W1B-01/02/03 and their tests, additive metadata migrations, pinned and
shipped-artifact assertions. Source for review only: no acceptance, promotion,
deployment, admission/release, receipt reducer or dispatch activation.
Attendance remains `foundation_only` and physically denied.

Verified clean local/remote feature starting heads:
APP `c3459dc3e6c530a8256e803827d22d9d2ee60865` and Evolution
`89a06d2f29d1f50d75e2e14523114af2c992e26d`. Deploy remains
`94a8905d586e1156ddefe04fac9def8ebfcb171b`; Evolution main remains
`334b9119030aec6c9241fd8fe878d03aceef83cc`. Upstream remains
`e273b904d53f5726970fd6a244ed9caa61dfeb9a`, Baileys `7.0.0-rc13` and its
accepted lock integrity. Both current Wave 1B feature branches are preserved.

## W1B-01: bounded semantic purpose and lowest gate

Pinned trace: Evolution `updateMessage` -> `sendMessage(...,{edit:key})` ->
`Utils/messages.js` type 14 with `key/editedMessage/timestampMs` ->
`relayMessage` -> completed stanza `bindStanza` -> lexical `sendNode` gate.
A fresh outer ID cannot exempt a customer edit. Revokes, reactions, pins,
message-targeting protocol keys and known customer settings are also denied
on managed AND ambiguous sockets. Bounded wrappers cannot hide these actions.
Other protocol containers default to unresolved and denied, never internal.

The sole proven outbound internal allowlist is PDO 4, incoming direct-message
placeholder recovery from our authenticated own phone. Only the exact pinned
constructor can privately mark its object in a WeakMap. Strict fields, bounded
list, fromMe=false, direct message keys, own final recipient, exact socket and
session and unchanged object fingerprint are required. Copied JSON, caller
attributes, outgoing placeholder requests, unknown enums and later mutations
do not confer trust. The object fingerprint is a local mutation check, not
cross-language authority.

### ProtocolMessage.Type matrix: all pinned values

| Value / operation | Outbound classification on managed/ambiguous sockets |
| --- | --- |
| 0 REVOKE | Customer-affecting; deny |
| 3 EPHEMERAL_SETTING | Customer conversation setting; deny |
| 4 EPHEMERAL_SYNC_RESPONSE | Unresolved; deny |
| 5 HISTORY_SYNC_NOTIFICATION | Unresolved; deny |
| 6 APP_STATE_SYNC_KEY_SHARE | Unresolved outbound; deny; inbound unchanged |
| 7 APP_STATE_SYNC_KEY_REQUEST | Unresolved outbound; deny |
| 8 MSG_FANOUT_BACKFILL_REQUEST | Unresolved; deny |
| 9 INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC | Unresolved; deny |
| 10 APP_STATE_FATAL_EXCEPTION_NOTIFICATION | Unresolved; deny |
| 11 SHARE_PHONE_NUMBER | Customer-affecting; deny |
| 14 MESSAGE_EDIT / editedMessage | Customer-affecting; deny |
| 16 PEER_DATA_OPERATION_REQUEST_MESSAGE | Trusted incoming PDO 4 only is internal; others unresolved |
| 17 PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE | Unresolved outbound; inbound unchanged |
| 18 REQUEST_WELCOME_MESSAGE | Unresolved; deny |
| 19 BOT_FEEDBACK_MESSAGE | Unresolved; deny |
| 20 MEDIA_NOTIFY_MESSAGE | Unresolved; deny |
| 21 CLOUD_API_THREAD_CONTROL_NOTIFICATION | Unresolved; deny |
| 22 LID_MIGRATION_MAPPING_SYNC | Unresolved outbound; inbound unchanged |
| 23 REMINDER_MESSAGE | Unresolved; deny |
| 24 BOT_MEMU_ONBOARDING_MESSAGE | Unresolved; deny (pinned spelling) |
| 25 STATUS_MENTION_MESSAGE | Unresolved; deny |
| 26 STOP_GENERATION_MESSAGE | Unresolved; deny |
| 27 LIMIT_SHARING | Customer conversation setting; deny |
| 28 AI_PSI_METADATA | Unresolved; deny |
| 29 AI_QUERY_FANOUT | Unresolved; deny |
| 30 GROUP_MEMBER_LABEL_CHANGE | Customer-affecting; existing Groups guard remains authoritative |
| Future enum / any protocol carrying a message key | Unresolved deny / customer-affecting deny |

PDO submatrix: 0 UPLOAD_STICKER, 1 SEND_RECENT_STICKER_BOOTSTRAP,
2 GENERATE_LINK_PREVIEW, 3 HISTORY_SYNC_ON_DEMAND, 5 WAFFLE_LINKING_NONCE_FETCH,
6 FULL_HISTORY_SYNC_ON_DEMAND, 7 COMPANION_META_NONCE_FETCH,
8 COMPANION_SYNCD_SNAPSHOT_FATAL_RECOVERY, 9 COMPANION_CANONICAL_USER_NONCE_FETCH,
10 HISTORY_SYNC_CHUNK_RETRY and 11 GALAXY_FLOW_ACTION are unresolved outbound
and denied. PDO 4 PLACEHOLDER_MESSAGE_RESEND is internal only with the private
proof above. Reachable pinned outbound constructors are history fetch (3)
and placeholder fetch (4); history fetch is not internal socket control.

Non-message ACK/receipt/IQ/presence and lexical noise/handshake remain unchanged.
Unmarked raw message nodes, exported raw bytes and voice-call message nodes
cannot mint purpose. Existing Groups and financial guards remain installed;
their modules are unchanged. Non-managed legacy edits are unchanged. Ordinary
generic writers keep the accepted APP-owned 1B cutover behavior; this delta
does not activate 1C cutover. Attendance capabilities/reserved IDs stay denied.

## W1B-02: ERROR ACK journal boundary

Exact `handleBadAck` attrs.error branch awaits `captureBadAck` BEFORE
privacy-token/timelock work or `messages.update`. It reuses `capture`, bounded
`ReceiptWorker`, recovery buffer and `append`: journal + outbox in one
transaction, independently of Message persistence. Only direct PN/LID evidence.

Normalized ERROR (outgoing only), semantic `message-ack-error`, origin
`baileys.handleBadAck.pre_buffer`, category `message_ack_error`, ASCII code
1..32 characters or null; source/capture timestamps stay distinct. Wrong
direction is UNKNOWN. No raw node, unbounded text or secrets are persisted.
Persistent dedupe binds status/code/source/session, excluding capture time
and UUID: identical repeats dedupe; changed codes and later receipts remain
distinct. ERROR grants neither positive ACK nor retry nor proof of no send.
APP receipt intake/reduction remains 1C; unsupported receipt events are retained.

### Pinned message-status producer map

| Producer / callback | Status evidence | Captured? / reason |
| --- | --- | --- |
| handleReceipt / CB:receipt | SERVER_ACK, DELIVERY_ACK, READ, PLAYED, UNKNOWN | YES, managed DM before emit/buffer |
| handleBadAck / CB:ack,class:message with error | ERROR | YES, managed DM before secondary work/emit |
| Same ACK callback without error | No positive status emitted | NO: not a positive producer |
| Group/status handleReceipt message-receipt.update | Per-participant receipt | NO: separate Groups/broadcast domain |
| Utils/messages generateWAMessageFromContent | PENDING | NO: local construction, not authenticated ACK |
| Utils/decode-wa-message fromMe branch | SERVER_ACK on received/echo WebMessageInfo | NO: direction/presentation inference, not receipt semantic proof; never managed ACK authority |
| History/PDO response WebMessageInfo upsert | Stored historical status | NO: historical presentation; future authority is 1C |
| Utils/event-buffer | Merge of existing evidence | Not a producer; both live receipt hooks precede it |
| process-message edits/revokes/invite expiry; media reupload; placeholder update | Content/stub/expiry, no delivery status | NO: not message-status evidence |
| handleCall/getCallStatusFromNode | Call lifecycle | NO: not message delivery |

Full pinned Socket/Utils search found no other live direct-message ACK/error
emitter. Incoming secondary failures do not become outgoing delivery failure.
WAID alone remains ordinary transport correlation, not financial history.

## W1B-03: exact canonical_json_v1

SHA-256 lowercase hex over exact UTF-8 JSON, no BOM/whitespace/newline. Both
implementations directly write recursive bytes, not sorted JS object enumeration.

* Object string keys: Unicode scalars, unsigned lexical UTF-8 byte order
  (equivalent scalar/code-point order). `"10"` precedes `"2"`; U+E000 precedes
  U+10000. Case/punctuation follow bytes. No Unicode normalization; composed
  and decomposed keys stay distinct. Arrays preserve order.
* Escape quote/backslash and `\b/\t/\n/\f/\r`; remaining U+0000..001F use
  lowercase `\u00xx`. Slash, BMP/supplementary and U+2028/U+2029 stay literal.
  Reject invalid UTF-8/lone surrogates.
* Integers only, [-9007199254740991,9007199254740991], decimal, zero `0`.
  Reject Ruby Float, JS noninteger/nonfinite, unsafe integers. Signed JS
  envelopes must already be canonical bytes, rejecting fractional/exponent
  lexemes or rounding hidden by JSON.parse.
* `true/false/null`; no undefined/Symbol/BigInt/binary/Date/custom prototype,
  accessor/holey array/cycle. No toJSON hooks. Maximum depth 64.
* APP authenticated intake rejects duplicate keys. Evolution signed canonical
  envelope parsing requires exact canonical bytes; duplicate keys cannot hide.

Payload/intent, authority, content/preparation, request, receipt source and
event digests all use the helper. Signed context/grant/intent/common event
contracts require `canonical_version`; durable records carry the same version.
No casing/field transformation follows hashing. Exact event wire bytes are
canonical: APP raw-body fingerprint equals Evolution outbox fingerprint.
HMAC authenticates those exact bytes; retry UUID/body stable, timestamp fresh.
Unrelated legacy, financial, Groups and local mutation fingerprints keep
their established domain-specific formats.

Shared corpus `fixtures/attendance-canonical-json-v1.json` is identical to
APP `spec/fixtures/attendance/canonical-json-v1.json`: 15 accepted fixed byte/hash
cases and 18 rejection cases. Expected values are checked-in constants, never
computed by the test's own serializer. Numeric/nested keys, insertion order,
arrays/empty/null/bool, controls, BMP/supplementary, composed/decomposed Unicode,
punctuation/case, separators and integer bounds are covered.

## Additive persistence, assertions, tests and runtime

Provider migration `20261005000001_attendance_canonical_version` adds four
version columns for PostgreSQL/MySQL. Old rows stay `legacy_unversioned`;
no hash/body/UUID/candidate backfill. Constraints and immutable version guards
prevent relabeling; existing immutable journal/context guards remain. Old
preparations fail closed, old outboxes retained unsupported, managed history
still managed. APP adds migration 20261005000002; historical migrations untouched.

Patcher validates exact pinned enum values and constructor/bad-ACK cardinality
before writing any file: zero/multiple fail. Shipped-artifact assertions inspect
installed Baileys hooks, capture ordering, every provider's compiled model,
canonical helper/corpus and real editedMessage at the lowest gate. Docker
copies the helper/corpus/tests and both additive migrations into real artifacts.

New tests cover managed/ambiguous edits/mutations, unknown enums, raw forgery,
trusted control/mutation, legacy/Groups/financial preservation, ERROR atomicity,
dedupe/changed code/later receipt, wrong direction/domain, append health,
canonical corpus/version, stable wire fingerprint and unsupported old records.
Provider test source covers ERROR commit/rollback and immutable metadata.

PROJECT TEST SUITES NOT EXECUTED LOCALLY —
EASYPANEL IS THE DESIGNATED BUILD/RUNTIME VALIDATION ENVIRONMENT

Only syntax and Git/source checks ran. EasyPanel must verify source patch/build,
final artifact assertions, migrations/transactions, driver deadlines and socket
compatibility. Append failure still trips sticky health with bounded recovery;
crash before durable commit may lose evidence. No retransmission guarantee,
exactly-once claim or production database operation. Source re-attack found no
customer protocol exemption without private internal proof, no pinned DM ERROR
emit before bounded capture attempt, and no differing bytes in the allowed
cross-language domain. Runtime confirmation remains pending.
