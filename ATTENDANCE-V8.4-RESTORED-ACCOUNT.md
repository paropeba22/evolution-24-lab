# V8.4 restored account byte representation

Baseline: `main`, `8ff35b5a7477b2500cf5052eec04385dccf2dc73`.
Candidate: `fix/v8.4-restored-account-attestation`.

## Finding and limits

The supplied production event proves that the existing restored-account hook
reached a registration and failed V8.3's combined key type/length check. It
does not distinguish a missing key, a different type or an invalid length.
No production credentials or storage configuration were accessed. Production
key state and production recovery remain **indeterminate**.

A deterministic representation defect is independently proven in the exact
source used by the Dockerfile: EvolutionAPI
`e273b904d53f5726970fd6a244ed9caa61dfeb9a`, Baileys `7.0.0-rc13`.
This candidate repairs that demonstrated path; it does not claim that the
production event has been uniquely attributed to it.

## Static chain of provenance

1. `lib/Utils/validate-connection.js:configureSuccessfulPairing()` decodes
   `ADVSignedDeviceIdentityHMAC`, checks its HMAC, then decodes its signed
   identity details as `proto.ADVSignedDeviceIdentity`. The decoded
   `accountSignatureKey` originates in that account message. The returned
   `authUpdate.account` is the decoded protobuf object, not a plain copy.
2. `encodeSignedDeviceIdentity(account, false)` spreads a **copy** before
   setting the copy's key to null for the wire reply. It does not erase the
   account returned in credentials. No assignment omitting the persisted
   account key was found in the inspected rc13 JavaScript.
3. `lib/Socket/socket.js` captures `const { creds } = authState`; pairing emits
   `creds.update`, and its listener performs `Object.assign(creds, update)`.
   Evolution passes `this.instance.authState.state.creds` into socket auth and
   calls that auth state's `saveCreds()` on the credentials event.
4. `WAProto/index.js:ADVSignedDeviceIdentity.prototype.toJSON()` delegates to
   `toObject(this, $protobuf.util.toJSONOptions)`. Those options specify
   `bytes: String`; `toObject()` encodes account byte fields as Base64.
   JavaScript invokes this `toJSON()` before the JSON replacer sees the object.
5. `lib/Utils/generics.js:BufferJSON.replacer` wraps Buffers/Uint8Arrays as
   tagged objects. The account fields have already become strings, so the
   replacer leaves them unchanged. `BufferJSON.reviver` handles tagged Buffer
   objects and numeric objects, not these plain Base64 strings. The bytes are
   preserved as reversible text, but the restored type is incorrect for V8.3.
6. The overlay's two observation hooks independently call the strict
   `verifyPublicAccountSignature()`. The restored hook runs at the beginning
   of `CB:success`; it receives that socket's `authState.creds`. Its timing and
   configuration/registration mapping are unchanged by this candidate.

## Supported authentication providers

Evolution's `defineAuthState()` selects provider files first, Redis with
`SAVE_INSTANCES` second, or Prisma with `SAVE_DATA.INSTANCE` third. It passes
the instance ID to those providers; the candidate does not change selection,
namespaces, reads or writes.

| Path | Account serialization and restoration inspected |
| --- | --- |
| Redis | `use-multi-file-auth-state-redis-db.ts` calls `CacheService.hSet/hGet`; CacheService and RedisCache each serialize/parse a layer with BufferJSON. Plain account strings survive both layers. LocalCache's equivalent hash layer was also inspected. |
| Prisma | `use-multi-file-auth-state-prisma.ts:writeData` serializes with BufferJSON; `saveKey` JSON-serializes that string; `getAuthKey` removes the outer layer; `readData` applies BufferJSON.reviver to the inner JSON. Account strings survive. |
| Provider files | `use-multi-file-auth-state-provider-files.ts` writes JSON with BufferJSON; on an object response it reserializes `response.data` and parses with the reviver. ProviderFiles uses instance/key HTTP paths. The external server's implementation was not available or contacted. |
| Baileys filesystem helper | `use-multi-file-auth-state.js` uses JSON.stringify/replacer and JSON.parse/reviver directly and exhibits the same representation defect. Evolution's inspected `defineAuthState` does not directly select this helper for credentials. Prisma's local file fallback stores non-credential Signal keys. |

The offline reproduction executes the exact rc13 protobuf decoder and
BufferJSON export, with the above JSON layers modeled in memory. It neither
invokes provider implementations nor asserts anything about live storage.

## Narrow correction

`nexi-attendance.cjs` restores only canonical, bounded standard Base64 strings
in `accountSignatureKey`, `accountSignature` and `details`, and only for the
existing `verified_restored_account` provenance. A round-trip Base64 check
rejects noncanonical pad bits; whitespace, URL-safe variants, missing padding,
arrays and tagged objects do not receive a new conversion path.

The recovered bytes are temporary inputs to the existing validation and
verification, not assigned to `authState.creds` or saved anywhere. Existing
Uint8Arrays remain unchanged. Missing bytes receive no default, reconstruction
from another field, new key or signature. Pairing does not gain string decoding.

Key rejection diagnostics now distinguish:

- `account_signature_key_missing`: null/undefined key.
- `account_signature_key_wrong_type`: unsupported byte representation.
- `account_signature_key_wrong_length`: a byte array fails the key length check.

An unsupported encoded string is classified as wrong type; if a canonical
string is decoded, the existing byte length checks apply to the recovered bytes.
Logs retain only the existing categorical fields and booleans, without key
values, exact lengths, content, hashes or serialized representations.

## Cryptographic and isolation preservation

The strict verifier is unchanged: the same libsignal primitive receives the
Signal public key version byte and requires its result to be `=== true`.
`publicAttestation()` still independently requires `verified === true`. It
verifies the unchanged account prefix, original account details and this
socket's signed identity public key, against the original account signature.

Attestation construction occurs only after those checks. `sessionObserved()`
still returns for null evidence, so a fresh registration remains without
attestation until actual verification succeeds. No attestation is loaded from
another socket or storage history. The existing session fingerprint and
authenticated public-material/registration digests are preserved.

WriterIsolation, StorageGuard, HMAC, WriterBarrier, physical send paths,
instance separation, credentials persistence and both hook positions are
unchanged. There is no automatic credential deletion, QR request or activation.

## Validation

- Static source inspection preceded edits. Baseline and repository origin
  were checked before creating the candidate worktree.
- Baileys archive SHA-512 matched Evolution's lock and the overlay integrity
  pin. The inspected protobuf, BufferJSON, pairing, socket, filesystem helper
  and crypto files matched archive contents byte for byte.
- Local libsignal `6.0.0` and curve25519-js versions and installation
  integrities matched the upstream lock. The initial evidence directory used
  a newer protobufjs; final validation used protobufjs `7.6.2` and the differing
  runtime support packages at their exact lock versions, with archive
  integrities verified. Only packages were extracted; no install scripts ran.
- `node --check nexi-attendance.cjs` and
  `node --check attendance-wave1b.test.cjs`; `git diff --check`.
- Six focused offline tests passed with the existing network trap preloaded:

  ```text
  node --require ./attendance-test-network-trap.cjs --test \
    --test-name-pattern='attestation|Signal account signature|rc13 protobuf account|pinned observation patch' \
    attendance-wave1b.test.cjs
  ```

  `NODE_PATH` pointed to isolated test packages outside tracked files. The
  protobuf export and BufferJSON code were loaded without importing sockets.
  The tests use synthetic account material and in-memory repositories only.
  They prove exact byte recovery and equal authenticated digests; real positive
  signature verification; rejection after changes to key, signature, details
  or device identity; rejection of false/nonboolean results and verifier errors;
  missing attestation after rejection; and no inheritance by replacement
  registrations. The existing observation anchor and diagnostic privacy tests
  also pass.

No Docker build, migration, integration test, deployment, activation queue or
real WhatsApp execution was performed. Main was not modified or promoted.

## Remaining risks

Production might instead have missing or damaged material, or another
unsupported representation. The new categorical rejection diagnoses those
conditions without granting authority. This change cannot recover absent
bytes or invalid signatures. It also does not resolve a later LID/session
fingerprint change or another independent writer gate failure. The provider
files server and live storage behavior have not been integration-tested.

Modified files: `nexi-attendance.cjs`, `attendance-wave1b.test.cjs`, and this
report. The candidate commit SHA is supplied in the delivery message.
