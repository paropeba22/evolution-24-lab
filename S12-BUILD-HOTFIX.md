# S12 Evolution build hotfix

The S6 validation correction dated 2026-10-19 below supersedes the original S6
validation claim: that replay preceded the final three type assertions.

Baseline: `eff836cd7fb8be54a7dde4e9c55e0af563c0aed3`, branch
`candidate/v23-prod-13-s12-cutover-safety`. Upstream remains pinned to
`e273b904d53f5726970fd6a244ed9caa61dfeb9a`.

## First divergence and correction

The original error is thrown by `authenticatedChatwootRoute` in
`patch-channel-transport.mjs` (baseline line 182). It requires the webhook POST
immediately after the `findChatwoot` GET, the same controller/schema/DTO, an exact
validation/dispatch/response shape, and the constructor/class closing boundary.

The current source still registers `/chatwoot/webhook/:instanceName` in
`ChatwootRouter`, adjacent to `find`, using the same instance schema, DTO and
controller. The newly compiled bundle closes the constructor/class inside an
esbuild lazy module initializer: `}}});`, instead of the older eager `}};`.
The remaining ownership checks pass. This was reproduced on a fresh composed
MySQL bundle using the baseline patcher: the exact EasyPanel error occurs and
the rejected patch leaves the input byte-identical.

`closesRouter` accepts precisely those two layouts. Both the authenticated
Chatwoot route and the subsequent `webhook/find` patch need the same correction.
Uniqueness, adjacency, controller/schema/DTO bindings, lazy authentication before
validation/dispatch, response shape and marked-bundle checks remain in force.
Unexpected boundaries, moved/duplicate routes and altered bindings still fail.

The next PostgreSQL build gate also exposed three existing TypeScript errors in
the ingress overlay: protobuf's optional key versus `WAMessage`, and spreading
Prisma JSON keys. Three erased type assertions resolve these errors. Both the
emitted service JavaScript and the complete PostgreSQL `main.js` were compared
byte-for-byte before/after these type changes: identical. No Signal logic changes.

One runtime-model test still expected the pre-S12 migration-running entrypoint.
It now checks the existing S12 runtime script, provider selection before startup
and absence of automatic migrations. Neither Dockerfile nor startup was changed.

## Verification

Local build artifacts used the pinned upstream archive, lockfile dependencies
(Node 24.16.0, TypeScript 6.0.3, tsup 8.5.1, esbuild 0.27.7), and all source patches
in Dockerfile order. No application, database, Redis, container or external
deployment environment was started. Prisma generation used dummy local URIs;
no operational credentials or licensing overrides were supplied.

- Baseline red/corrected green on the identical newly compiled MySQL artifact.
- `npx tsc --noEmit`: PASS for the fully composed PostgreSQL source.
- `npx tsup src/main.ts`: PASS for MySQL and PostgreSQL, using the composed tsup
  configuration and its production dependency graph. This targets the runtime
  entry, rather than emitting every unused standalone source entry.
- Actual `patch-instance-create.mjs` and full `patch-channel-transport.mjs`: PASS.
- Model, groups and attendance build assertions: PASS for MySQL, PostgreSQL and
  psql_bouncer. Marked channel patch reapplication is byte-identical.
- `assert-baileys-transport-runtime.mjs` and `assert-ingress-runtime.mjs`: PASS
  against the composed shipped artifacts for all providers.
- MySQL bundle/auth/cutover/authority/physical unit battery: 207 PASS, zero skips.
- PostgreSQL bundle/auth tests: 142 PASS; runtime-model tests: 11 PASS after fixing
  the stale entrypoint expectation.
- `verify-ingress-r2.mjs`: PASS, including actual adapter/debounce behavior.
- Compiled handler authentication test: missing/invalid signatures, expired
  timestamps and foreign account/inbox never validate or dispatch; valid signed
  synthetic request executes once and replay never executes twice.
- Hold tests retain fail-closed consume/dispatch/wire/probe behavior and read-only
  consumption readback. All sends and storage in these tests are synthetic.

Docker is unavailable locally. The complete Linux image build/export and final
EasyPanel Force Rebuild remain to be executed by Luna. This report does not claim
that an EasyPanel image was built or deployed.

## Build-secret exposure

No original EasyPanel log or connected panel session was available here, so the
specific exposed key names/categories cannot be established from evidence in
this task. Only sanitized argument names were requested; no values were copied.
Do not treat the following rotation inventory as confirmed exposures.

The [EasyPanel builder documentation](https://easypanel.io/docs/builders) confirms
that project/service environment values are passed as Docker build arguments.
This Dockerfile declares only the two optional licensing endpoint arguments;
operational runtime secrets are unnecessary for compiling this image. A
Dockerfile change cannot redact a command logged by the invoking builder.

Avoiding a repeat requires argument allowlisting/log redaction in the builder,
or coordinated separation of build inputs from runtime secrets; secret build
inputs require a secret-aware mechanism. Do not remove required runtime variables
or change the deployment strategy impulsively during cutover. Restrict access
to the affected log and avoid screenshots/exports containing argument values.

After identifying the exposed names, coordinate rotation by confirmed category:
database/cache credentials and credential-bearing URIs; API/integration tokens;
webhook/event/authority signing secrets; storage credentials; and licensing/build
credentials if present. Update producers/verifiers together where needed, and
account for retained backlog and signed envelopes before retiring signing keys.
No operational credential was rotated in this hotfix.

## Cutover handoff

No new migration. No migration executed. No changes to runtime hold,
WriterBarrier, backlog, physical-send authorization, Redis state or consumers.
No merge to main and no new environment. Luna can rebuild the pushed S12
candidate on the existing EasyPanel service and retain all S12 hold gates.

## S6 follow-up: complete composition replay (2026-10-19)

The operational thread records Luna's confirmation from EasyPanel history that
the failed execution used `ec0b09cfa76af8c84fbf26536913fa69948b284f` on this S12
branch. Local HEAD and the remote branch were independently checked at that SHA.
The owner's authorization is limited to correcting S6 for that confirmed build.
No new EasyPanel operation was performed from this coding task.

The failure is real: S6 hashes the entire normalized TypeScript source, including
erased type assertions. Its expected provider-source hash still described the
composition before ec0b09c's three type assertions. The previous local validation
ran S6 before those assertions and did not repeat the entire chain afterward.

A fresh local artifact replay used the pinned upstream archive and pristine
Baileys 7.0.0-rc13 / Chatwoot SDK 1.1.17 package tarballs. SHA512 integrity matched
the upstream lockfile. All source patchers were executed in the Dockerfile's
actual order, through ingress and ingress-integrations, then S6. No source bytes
were manually edited between those stages.

Exactly one of six S6 input fingerprints differed. Comparing the entire provider
source against the historical accepted composition proved that the only changes
are the three existing type assertions; emitted JavaScript is byte-identical.

The only patcher change replaces the provider-source expected SHA256:

- Previous: `56d0a31141622514bd972d26a6c01b657f95ed10655173a95052d8afcf866448`
- Current: `4f968359cf1dbaabe7db36bac057b55f61d4fbee61385f73678f48f6abe22ecb`

The old hash is not retained as an alternate accepted input. All other hashes,
anchors, preflight checks and fail-closed behavior remain unchanged.

Validation completed:

- RED: ec0b09c's patcher reproduced the exact S6 error on the fully recomposed
  input, with all six inputs unchanged and no manifest written.
- GREEN: corrected S6 `--snapshot` completed on that same input, followed by
  `assert-baileys-transport-runtime.mjs --source-only` and
  `verify-ingress-r2.mjs`, all PASS.
- All six final patched source files match the previously validated final
  artifacts; every shipped runtime fingerprint in the S6 manifest is unchanged.
- `baileys-transport-s6.test.cjs`: 35 PASS, zero skips. New negative cases change
  each of the six fingerprinted inputs and restore the historical pre-typefix
  source. Every case is rejected before any file, snapshot or manifest write.
- `nexi-transport.test.cjs` and `cutover-safety.test.cjs`: 27 PASS, zero skips,
  including the previously compiled PostgreSQL handler's real authentication
  boundary, replay rejection and held consume/dispatch/wire behavior.
- Syntax and `git diff --check`: PASS.

Evidence is retained locally under ignored `.test-runtime/s6-*` artifacts.
This follow-up changes only `patch-baileys-transport.mjs`, its S6 regression tests
and this report. No Dockerfile, runtime helper, Signal/hold/WriterBarrier policy,
authentication implementation, migration, consumer or remote environment changes.
The complete Linux image build remains Luna's next EasyPanel gate.
