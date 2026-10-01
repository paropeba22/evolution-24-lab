# Chatwoot bundle anchor correction

Baseline: `be1af46e6f41ec63b66d38470995041eb9ea7cf0`.
Upstream remains pinned to `e273b904d53f5726970fd6a244ed9caa61dfeb9a`.

## Evidence and limits

EasyPanel reported `per-instance chatwoot service: exact bundle pattern changed`
after successful MySQL tsup compilation and successful instance/create patching.
The failed intermediate bundle was not retained. The error proves that the old
literal anchor was absent or duplicated; it does not identify the new symbol or
prove that identifiers were the only difference.

The pinned source has exactly two `new ChatwootService` expressions:

- `src/api/services/channel.service.ts`: `this.chatwootService` receives
  `new ChatwootService(waMonitor, this.configService, this.prismaRepository, this.chatwootCache)`.
- `src/api/server.module.ts`: the module singleton receives
  `new ChatwootService(waMonitor, configService, prismaRepository, chatwootCache)`.

Both use the unchanged four-argument constructor from `chatwoot.service.ts`.
The existing source patchers do not change these constructions or the constructor
signature. They do change method bodies and tsup external-module configuration.
Those changes can affect minified symbol allocation; the precise allocation and
module ordering of the failed build cannot be determined from its error log.

Historical MySQL/PostgreSQL bundles each contain one matching per-instance
construction and one matching singleton. Their symbols are `Qe(R,...)` and
`ye(O,...)`, respectively. Two other `this.chatwootService` assignments inject an
existing service into controllers and must remain untouched.

## Match contract

The per-instance matcher fixes the property name, four-argument arity and last
three `this` property arguments. It captures the constructor and monitor names.
The singleton matcher uses that captured constructor, requires four identifier
arguments and verifies the same monitor binding. Its assigned identifier is also
captured for the existing authenticated-webhook provider lookup.

Each target must have exactly one structural match and one constructor-assignment
candidate. Missing, duplicate, malformed or mixed old/corrected targets throw.
Both targets are validated before applying either wrapper. Only
`require("/evolution/nexi-transport.cjs").isolateChatwoot(...)` is inserted; the
constructor expression and arguments are preserved byte-for-byte. The production
path writes only after all mandatory patches succeed.

A marked bundle must contain both corrected service targets and the corrected
webhook/find route. A valid marked rerun is byte-identical. An unmarked corrected
bundle is rejected rather than wrapped a second time. Unexpected formatting or
expression changes remain fail-closed.

## Focal anchor audit

| Class | Targets | Disposition |
| --- | --- | --- |
| A: structural, identifier-independent | webhook/find owning route; corrected service matchers | Strict uniqueness and structural validation retained. |
| B: identifier-sensitive with semantic context | managed Inbox requirement/storage; cached Inbox validation; stable Inbox resolution; authenticated webhook route; transport proof | Existing method/property/route context retained. No further drift demonstrated by available evidence. |
| B: identifier-sensitive with semantic context | local/global event redaction; QR callback redaction; missing client/instance/media/delete/template/outbound failure handling; signed events and fresh retry authentication | Existing event/operation context retained. Includes provider-specific module symbols in QR and Axios patterns; remains mandatory and fail-closed. |
| C: immediate companion to the observed failure | old per-instance constructor anchor; old singleton constructor anchor; hardcoded singleton reference inserted into authenticated webhook | Fixed together using captured symbols. No additional C target can be established without the failed bundle. |

This is a focal correction, not a claim that every remaining literal anchor can
survive arbitrary bundle drift. A future EasyPanel build remains the gate for the
current source graph. No Dockerfile, runtime helper, financial transport, retry,
recipient, ALS or final-wire behavior is changed.

## Validation

`node --test bundle-patch.test.cjs` exercises synthetic MySQL, PostgreSQL and
psql_bouncer shapes, renamed constructor/monitor/singleton/dependency identifiers,
unrelated injected services, constructor argument preservation, zero/duplicate/
malformed matches, mixed isolation states and marked/unmarked reapplication.

Read-only historical replay uses temporary copies of existing bundles, not a new
build. Full patch output is compared byte-for-byte with the baseline patcher;
marked reruns are also compared. Synthetic renaming of the historical constructor
and singleton reproduces the reported error with the old patcher and succeeds
with the corrected patcher while preserving every unrelated patch. The existing
bundle tests also run against fully patched historical copies for all three
provider settings. These fixtures establish the match contract, not the contents
of the discarded EasyPanel artifact.

No dependency installation, local tsup build, Docker build, push, promotion or
deployment is part of this correction.
