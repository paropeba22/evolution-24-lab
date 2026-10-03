# Compiled QR anchor correction

## Starting state and reproduction

Evolution repository: `paropeba22/evolution-24-lab`. Clean local `main`, fetched
`origin/main`, and the correction branch base all equal
`cc427068022769fbd304d86571962705dd8f83c3`. Correction worktree:
`evolution-compiled-qr-anchor`, branch `fix/evolution-compiled-qr-anchor`.
APP was inspected read-only: clean `package-02/command-center-shell` at
`b38c3f0fdb7f549cefb7b72bbb52186d56e2a998`.

Docker is unavailable and WSL is not installed. No container build or EasyPanel
rerun is claimed. The closest available gate was reproduced using an isolated
archive of the Dockerfile's exact upstream revision
`e273b904d53f5726970fd6a244ed9caa61dfeb9a`, existing dependencies, and the frozen
Evolution overlays. Mutable Baileys/Signal packages were copied before patching;
other existing dependency directories were reused through local junctions.
No dependencies were installed. Tooling: Node 24.16.0, tsup 8.5.1,
esbuild 0.27.7, Prisma 7.8.0. Licensing build values were empty.

MySQL used the existing Prisma generator and tsup executable. PostgreSQL used
the existing generator and `npm run build` (`tsc --noEmit && tsup`). Both builds
succeeded with the pinned tsup configuration, minification and source maps.
The original full transport patch then failed on the MySQL compiled bundle:

```text
Error: QR terminal log: expected 1 structural targets, found 0
applyAnchor ... patch-channel-transport.mjs:295:55
... patch-channel-transport.mjs:334:43
```

The original script, read from the exact base commit, also rejected both
providers with zero QR matches before and after `patch-instance-create`.
The QR owning method was byte-identical across that preceding transformation.

## Build order and proven cause

Docker order remains unchanged:

1. Pinned upstream checkout and dependencies (installation was not repeated locally).
2. Prisma binding patch.
3. Financial source, trusted Baileys, managed retry, then Groups source overlays.
4. Per provider: Prisma generation, build, instance-create patch, channel patch,
   runtime-model assertion, Groups runtime assertion, bundle copy.
5. Copy PostgreSQL to `psql_bouncer`, validate provider copies, run tests.
6. Copy compiled artifacts and external helpers into the final image and assert again.

The historical terminal callback directly invoked `this.logger.log`:

```js
renderer.default.generate(qr,{small:!0},output=>this.logger.log(/* exact instance/pairing/count template */+output))
```

The accepted `patch-groups-source.mjs` inserts a lifecycle predicate in that
callback. Its actual compiled MySQL form is:

```js
Lo.default.generate(A,{small:!0},g=>require("/evolution/nexi-groups.cjs").lifecycleCurrent(n)&&this.logger.log(/* same template */+g))
```

PostgreSQL uses `_o` for the renderer, with the same callback and guard shape.
The original pattern required `=>this.logger.log`; the inserted predicate
therefore made the legitimate match count zero. This is an accepted source
overlay / compiled-anchor mismatch, not a provider, source-map, build-mode,
instance-create, or transformation-order difference. Earlier channel anchors
are unnecessary to reproduce the failure.

## Correction and preservation

The QR pattern supports only two explicit callback forms: the historical
direct logger and the exact external Groups `lifecycleCurrent(identifier) &&`
predicate followed by that logger. Both retain the exact QR renderer call,
small option, instance/pairing/count diagnostic expressions, and callback-output
backreference. No wildcard callback, optional application, or count relaxation
was added. Identifier captures avoid provider-specific minified names.

The replacement retains the captured lifecycle predicate and emits only
`message`, `instanceName`, and `qrcodeCount`. The pinned qrcode-terminal callback
is synchronous. Removing terminal rendering/disclosure retains the existing
patch's semantics; pairing requests, base64 generation, QR events and
connection persistence remain byte-identical in the owning-method fixture.

`applyAnchor` remains unchanged: zero targets fail, one target patches, and
multiple targets fail. Failed application never writes a partial artifact.

Continuing the real compiled gate exposed three additional structural blockers:

* **Missing Chatwoot client anchor:** accepted control fencing separates the
  delayed client lookup from its condition. The new explicit alternative binds
  the checker declaration, both checker calls, timer callback and client result.
  Only the existing missing-client return becomes the existing provider error.
* **Outbound failure anchor:** accepted stale-owner and disconnect-failure
  branches precede the generic catch result. The matcher retains these branches
  byte-for-byte and applies the existing transport error only to the generic
  branch. Dynamic tests prove both control responses and the generic throw.
* **Groups artifact assertion:** the accepted tsup overlay externalizes
  `nexi-groups.cjs`; its private outbound denial literal cannot exist in the
  bundle. The assertion now verifies exact compiled helper bindings and the
  shipped helper's denial marker, then executes target and socket denials with
  synthetic inputs. Missing bindings, missing denial, and marker-only helpers
  with disabled executable protection all fail. No Groups domain code changes.

These are necessary corrections to the same build gate. Accepted transport,
financial, identity, Groups and lifecycle source files remain unchanged.
The artifact transport test now recognizes the exact lifecycle-aware catch
boundary as well as the historical supported catch.

## Fixtures and structural tests

`bundle-patch.test.cjs` embeds complete, byte-for-byte owning methods from the
actual MySQL pre-channel compiled bundle, rather than generated toy callbacks:

| Fixture | Bytes | SHA-256 |
| --- | ---: | --- |
| `connectionUpdate` | 7,328 | `00bdd2de2e31b777c04f705aa4c4f2c762a11ef57c7dc533f8c579613decaaa6` |
| Chatwoot `receiveWebhook` | 7,695 | `f61d5836074914b8da13603e9cc140d22b4e297a40c60ae3648a4fc2529ac201` |

The frozen original QR pattern finds zero current targets and one historical
target. Production matcher tests cover current and historical forms, renamed
bindings, absent target, duplicate current targets, mixed current/historical
ambiguity, unrelated QR/log diagnostics, wrong helper/predicate/operator,
missing/extra lifecycle arguments, wrong output/instance binding, malformed
callback closure and repeated application. Successful whole-method comparisons
prove only the intended terminal diagnostic changes. A stale-owner execution
emits nothing; a current owner emits exactly the safe metadata object.

The two additional transport anchors have actual owning-method fixtures,
absent/duplicate/malformed/repeated rejection tests and control-response
execution tests. The external Groups gate has seven positive/negative subtests.

## Compiled matrix and regressions

| Provider | Artifact and assertions | Full test run |
| --- | --- | --- |
| MySQL | Actual Prisma/tsup bundle; transport, model and Groups gates pass | 280 passed, 2 skipped, 0 failed |
| PostgreSQL | Actual Prisma/tsc/tsup bundle; transport, model and Groups gates pass | 280 passed, 2 skipped, 0 failed |
| psql_bouncer | Byte-identical PostgreSQL copy; bouncer schema / PostgreSQL compiled provider model and Groups gates pass | Inherits PostgreSQL bundle; provider selector and structural fixture coverage pass |

Generated-client assertions ran with each matching provider. Later copied-bundle
checks use `EVOLUTION_SKIP_GENERATED=1`, as in the Dockerfile, after provider
generation changes. Both patched bundles also pass `node --check`.

PostgreSQL focused artifact tests: **129 passed, zero failed/skipped**.
Full runs include patch/bundle, transport, direct PN/LID and identity,
financial source/recipient/native retry, Groups isolation, lifecycle R1-R5
(including R4/R5 historical and current-method cases), and pre-ACK admission
regressions. No accepted suite was rewritten to remove skips.

All four previously skipped artifact tests now execute and pass for both bundles:

* Patched image bundle preserves direct messaging and fails closed.
* Final webhook/find binds event proof to the validated instance.
* Webhook/find patch targets only its owning route and fails closed.
* Runtime model assertion rejects missing Chatwoot.inboxId.

Remaining skips are the real PostgreSQL concurrency/lease/ACK/constraints test
and real Redis Lua integration test. Their connection variables were cleared;
no database or Redis service was contacted.

Local evidence is retained outside the correction worktree under `../tmp/`:
`qr-anchor-historical-failure.log`, `qr-anchor-mysql-build.log`,
`qr-anchor-postgresql-build.log`, `qr-anchor-postgresql-artifact-tests.log`,
`qr-anchor-mysql-full-tests.log`, and `qr-anchor-postgresql-full-tests.log`.
Compiled provider copies are in `../tmp/qr-anchor-build/dist/providers/`.

## Delta review and security

Changed files: channel structural patch, Groups compiled assertion, their two
existing test files, and this evidence document. No Dockerfile, source overlay,
pin, schema, migration, domain/helper, APP, n8n, Chatwoot or EasyPanel configuration
change. No production values were used or copied. Fixture strings contain
upstream source expressions, not runtime QR/pairing values. No live API,
WhatsApp, QR scan, deployment, push, database or Redis mutation occurred.

Fresh delta inspection checked exact matching/counts, guard retention, provider
names, unchanged patch order, control catch semantics, unrelated transport,
financial/Groups changes, fixture provenance, and secret leakage. Syntax checks
and `git diff --check` pass. No remaining BLOCKER/HIGH/MEDIUM was identified.

The closest compiled-artifact gate passes. Container packaging and the next
real EasyPanel build remain unexecuted in this environment.

**NEXI EVOLUTION COMPILED QR ANCHOR CORRECTION COMPLETE — READY FOR DELTA REVIEW**
