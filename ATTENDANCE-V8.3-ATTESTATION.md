# V8.3 socket account attestation investigation

Base: `25c50065aa58332ee59d754c3cad5a552f9ed02c`.
Candidate: `fix/v8.3-writer-attestation-lifecycle`. No promotion or deployment.

## Production conclusion

The supplied V16/V8.2 evidence proves that the writer reached an existing,
correctly associated registration with no attestation. It does **not** prove
why the attestation was missing. HTTP 200 and an open, owned socket are not
account-signature evidence. This candidate does not claim production recovery.

The missing-attestation path receives categorical diagnostics. No hook is moved,
no observation is synthesized, and missing evidence continues to reject the writer.

## Code findings

Inspected the overlay, Evolution source at
`e273b904d53f5726970fd6a244ed9caa61dfeb9a`, and the npm Baileys `7.0.0-rc13`
archive, verified against the overlay's exact SHA-512 integrity pin. Inspected
libsignal `6.0.0` and curve25519-js against the upstream lock integrities.

1. `publicAttestation()` requires a session fingerprint, valid PN/LID, a 32-byte
   account signature key, a 64-byte signature and bounded nonempty account
   details. It verifies `account-prefix || account-details || device-public-key`.
   Missing/invalid inputs return null; prefix decoding or verifier exceptions
   leave the existing hook through its catch path.
2. `sessionObserved()` returns immediately for a missing registration or null
   attestation. Otherwise it stores the attestation synchronously **before**
   classification, authenticated context refresh and outbox persistence. Failure
   in those later awaits does not explain an attestation that was never stored.
3. `configure()` creates a new registration for each configured socket and
   captures that socket's credentials. It does not verify or load an attestation
   from the database. Historical context is receipt provenance only.
4. The financial config clone is created **before** registration. Baileys'
   `index.js` then creates `newConfig`; `inheritConfig()` maps both objects to the
   same registration. `trackSocket()` maps the returned socket to the registered
   original config. Groups admission passes that config to the factory. No
   deterministic config split was found along this path.
5. The pairing hook follows `configureSuccessfulPairing()`, which decodes the
   account, checks its HMAC, invokes its signature verifier and supplies `updatedCreds.account` and
   `updatedCreds.me`. The overlay verifies a merged view of original and updated
   credentials. `encodeSignedDeviceIdentity(account, false)` clones the account
   before omitting its key from the wire encoding; it does not clear the stored
   account key.
6. The restored hook runs at the beginning of `CB:success`, before its awaits
   and before the later `creds.update` replacing `me.lid`. Baileys updates its
   lexical credentials with `Object.assign(creds, update)`. `creds.update` is
   not a buffered event. There is no general attestation retry on creds updates.
   A LID change can therefore invalidate a previously verified fingerprint;
   this explains a possible **session mismatch**, not the supplied absence.
7. Evolution selects provider files, Redis or Prisma for auth restoration.
   Those paths revive credentials using `BufferJSON` (including the layered
   cache serialization). No production credential material or selected auth
   storage backend was inspected. Incomplete/invalid restored account material
   remains a hypothesis, not a finding.
8. Reconnection creates another registration. Its account must be independently
   verified by the new socket hook. Old socket evidence is not inherited by
   `configure()` or recovered from historical database context.

## Independently proven cryptographic defect and narrow correction

The pinned rc13 `lib/Utils/crypto.js` implementation calls
`curve.verifySignature(...)` and returns true unless it throws, discarding the
primitive's boolean result. The pinned libsignal implementation returns false
for a cryptographically invalid signature. An offline reproduction executing
the **exact rc13 Curve object** accepted changed signed bytes, while the
primitive rejected them. All keys and bytes were generated locally for the test.

This defect does not explain `attestation_present=false`. However, retaining
that wrapper would violate the requirement that a verified attestation require
real positive signature verification. Both attendance observation hooks now use
`verifyPublicAccountSignature()`: the same libsignal primitive, the same Signal
public-key version byte `0x05`, and an explicit `=== true` result. Exceptions
retain the existing hook handling. `publicAttestation()` also requires boolean
true. No change is made to other Baileys crypto consumers or its pairing policy.

The runtime image already copies the pinned libsignal package from the source
builder; no dependency, Dockerfile or installation policy changes are needed.
Valid signatures can establish evidence only for the registration reached by
the existing socket hook. Rejected signatures cannot establish evidence.

## Diagnostic interpretation

`attendance.attestation.observation` contains only `status`, an allowlisted
`trigger` and `registration_present`. It is emitted at the existing pairing or
restored observation point, even when the Baileys logger is silent.

`attendance.writer_probe.attestation` uses the existing probe correlation and
reports the registration's latest status/trigger plus booleans for registration,
credential object equality, attestation presence and session equality.

| Status | What it establishes |
| --- | --- |
| `not_observed` | No diagnostic observation was recorded for this registration in the candidate process. |
| `session_material_unavailable` | Fingerprint prerequisites were unavailable/invalid; signature verification was not reached. |
| `account_identity_invalid` | PN/LID validation failed before verification. |
| `account_material_unavailable` | Account material was absent before verification. |
| `account_signature_key_invalid` / `account_signature_invalid` / `account_details_invalid` | The named material failed type/length validation before verification. |
| `account_details_decode_failed` | Prefix decoding threw before verification. |
| `signature_verifier_failed` | The verifier was called and threw. |
| `signature_rejected` | The verifier was called and did not return boolean true. |
| `verified` | Verification returned true; inspect registration/session booleans to assess association. |
| `unexpected_failure` | An uncategorized observation error occurred; no raw error is emitted by the diagnostic. |

A verified observation with `registration_present=false` identifies an
unregistered config at that hook. A verified, present attestation with a false
session match identifies incompatible evidence, not permission to reuse it.
Credential object inequality identifies an object discrepancy; it does not by
itself prove a socket replacement. A newly configured replacement starts with
`not_observed` and no copied attestation. Diagnostics preserve the latest attempt,
not a complete history; the observation events describe individual attempts.

No diagnostic contains account identifiers, session fingerprints, public account
material, keys, signatures, credentials or raw exceptions. Logging failures do
not change verification or writer authorization. Diagnostic status is never
consulted to authorize a writer.

## Validation and static review

- Focused offline command: `node --require ./attendance-test-network-trap.cjs
  --test attendance-wave1b.test.cjs attendance-corrections.test.cjs
  attendance-canonical.test.cjs`: **37 passed, 0 failed**. Local resolution used
  an isolated installation of the locked libsignal dependency outside this repo.
- New tests cover categorical null/exception outcomes, real Signal signatures
  and adulteration of signature/details/device key/account key, nonboolean
  verifier returns, inherited config association, unregistered config,
  missing evidence denial, session/socket replacement, sanitized logs and
  diagnostic failures. Synthetic hook execution checks original observation
  order, merged pairing credentials and anchor drift rejection.
- The six-suite offline comparison adds authority, physical-dispatch and
  storage-corrections unit tests: base **397 passed / 9 failed** out of 406;
  candidate **401 passed / the same 9 failed** out of 410. Existing failures
  originate in dispatch fixtures lacking the webhook/context lookup needed by
  `refreshContext()` (`findUnique` on undefined), including downstream assertion
  failures. They were not repaired or suppressed in this scope.
- Applied the observation transform to the integrity-verified real rc13
  `socket.js`; both hooks and strict verifier references appear exactly twice.
  Parsed that transformed source and every changed JS file with `node --check`.
- Compared `writerIsolation()` with base after removing only the new diagnostic
  read: its decision body is byte-identical. `configure()`, `inheritConfig()`,
  `sessionObserved()` and `trackSocket()` are byte-identical to base.
- HMAC, StorageGuard, CAS, WriterBarrier, provider/instance checks, HTTP routes,
  authorization policies and existing send controls are unchanged. The runtime
  assertion checks both observation hooks and their strict verifier references.
- `git diff --check` passes. No real WhatsApp connection, QR, pairing, send,
  Docker build, migration, integration test, activation or deployment was run.

Changed files: `nexi-attendance.cjs`, `patch-attendance-source.mjs`,
`assert-attendance-runtime.mjs`, `attendance-wave1b.test.cjs`, and this report.

Production cause and recovery remain unproved until the candidate's categorical
observations and writer probe can be assessed through separately authorized
operational validation. Missing attestation remains a hard rejection.
