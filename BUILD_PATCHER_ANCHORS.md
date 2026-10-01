# Chatwoot bundle anchor correction

Current correction baseline: `ab433f734681c72b96b2f224f2a13f8db6b3c7be`.
First isolation correction parent: `be1af46e6f41ec63b66d38470995041eb9ea7cf0`.
Upstream remains pinned to `e273b904d53f5726970fd6a244ed9caa61dfeb9a`.

## Evidence and limits

After promotion of the isolation correction, EasyPanel passed the two service
isolation anchors and reported a new error:
`authenticated chatwoot webhook route: exact bundle pattern changed`.
TypeScript/tsup and instance/create patching again succeeded. The old route
depended on `v/b/pn` for MySQL and `T/P/Cn` for PostgreSQL, plus fixed handler
and callback names. Those names are not source contracts. The first correction
had addressed `per-instance chatwoot service: exact bundle pattern changed`.
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

A marked bundle must contain both corrected service targets, the corrected
webhook/find route, authenticated Chatwoot webhook and transport proof. A valid
marked rerun is byte-identical. An unmarked corrected
bundle is rejected rather than wrapped a second time. Unexpected formatting or
expression changes remain fail-closed.

## Focal anchor audit

Classification for this wave: A means stable property/string structure; B means
identifiers are captured or derived; C means an upstream minified name was still
hardcoded and exposed to the same drift. All remaining C targets are corrected.

| Target | Before wave | After wave / semantic binding |
| --- | --- | --- |
| Per-instance and singleton isolation | B | Unchanged: captured class/monitor/singleton, strict uniqueness. |
| webhook/find event proof | B | Unchanged: owning webhook/set service, captured validation and callback bindings. |
| Authenticated Chatwoot webhook | C | B: exact webhook POST and dataValidate dispatch; adjacent findChatwoot route using the same controller, schema and DTO; closing router boundary. |
| Chatwoot transport proof | C | B: owning findChatwoot GET, captured handler/validation/result bindings. |
| Managed Inbox ID requirement | C | B: setChatwoot parameter captured; repeated guard rejected. |
| Inbox ID storage/readback | C | B: nameInbox input captured; exactly three sites required. |
| Cached Inbox validation | C | B: cache key/client/request captures and repeated-value backreferences; collision-safe block local. |
| Stable Inbox resolution | C | B: payload/item/result/cache key captured; instance parameter derived from owning getInbox method. |
| Local/global event log redaction | C | B: sendData-Webhook or sendData-Webhook-Global context, log object, payload, URL and enabled/regex bindings. |
| QR terminal redaction | C | B: generate callback plus exact instance/pairingCode/qrcodeCount template and matching output parameter. |
| Missing client failure | C | B: Promise timeout callback and clientCw parameter captured. |
| Missing WhatsApp instance failure | C | B: conversation, instance and onSendMessageError bindings captured. |
| Media send failure | C | B: same sent result in guard and updateChatwootMessageId spread. |
| Delete send failure | C | B: sendMessage delete key/remoteJid and following repository deletion. |
| Template send failure | C | B: sendText telemetry, textMessage arguments and final bot response. |
| Outbound failure response | C | B: catch/error binding plus updateChatwootMessageId method boundary. |
| Signed Evolution event | C | B: complete header structure, matching instance/header/client/URL references, Axios create and local webhook retry call. |
| Fresh retry authentication | C | B: captured client and patcher-owned __nexiPrepared body. |

Method/property names, operation labels, helper paths, marker and patcher-owned
locals are A and retain their values. No upstream minified name or provider-specific
symbol branch remains in the patcher. Provider allowlisting remains unchanged.
Exactly one target is required for each patch, except the existing three-site
storage/readback contract. Transformations use validated offsets, named captures
and backreferences; failure never writes a partially patched production bundle.

The authenticated handler retains its original request, response and result
variables, schema, DTO, service and callback parameters. Its original dataValidate
call is copied into the lazy callback unchanged. The captured singleton supplies
getProvider({instanceName: request.params.instanceName}); the response uses the
helper result's status/body. Reusing the original result variable also avoids
introducing a local that shadows a captured schema identifier.

This remains a set of narrow pinned shapes, not a complete JavaScript parser.
Unexpected formatting or expression changes fail closed. A future EasyPanel build
remains the gate for the current source graph. No Dockerfile, runtime helper, financial transport, retry,
recipient, ALS or final-wire behavior is changed.

## Validation

`node --test bundle-patch.test.cjs` exercises synthetic MySQL, PostgreSQL and
psql_bouncer shapes, renamed constructor/monitor/singleton/dependency identifiers,
unrelated injected services, constructor argument preservation, zero/duplicate/
malformed matches, mixed isolation states and marked/unmarked reapplication.

Read-only historical replay uses temporary copies of existing bundles, not a new
build. Full patch output is compared byte-for-byte with the baseline patcher,
allowing only the authenticated handler's original result binding instead of the
old inserted `v` binding;
marked reruns are also compared. Synthetic renaming of the historical constructor
and singleton was covered in the first wave. This wave additionally renames
controller/schema/DTO, log, QR and Axios symbols in complete historical bundles.
The corrected patcher preserves the expected transformations. The existing
bundle tests also run against fully patched historical copies for all three
provider settings. Synthetic focal cases cover renamed identifiers, zero,
duplicates, malformed repeated-value bindings, unrelated routes, lazy dispatch,
result/schema identity, marked/unmarked reapplication and local binding collisions.
Captured identifiers containing `$$` are preserved literally by callback-based
fragment replacements. Legacy marked historical output also remains byte-identical.
Image assertions derive symbols rather than depending on historical provider
letters. These fixtures establish the match contract, not the contents
of the discarded EasyPanel artifact.

No dependency installation, local tsup build, Docker build, push, promotion or
deployment is part of this correction.
