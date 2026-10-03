# NEXI Groups V1 — authority and inbound foundation

Overlay baseline: `553a888ececf97bb60a80c1a5987185bbd56d0de`. APP baseline: `04fef75df45fa3eb86335c7d7f13c4c78b3dbc91`. Docker source remains pinned to `e273b904d53f5726970fd6a244ed9caa61dfeb9a` with Baileys `7.0.0-rc13`.

Final N1 lifecycle correction: all native status/cleanup/reconnect callbacks are fenced by captured socket ownership, and recoverable startup failures stay in monitor tracking. See [D1/D2 semantics, reproductions and runtime gates](GROUPS-WAVE1-N1-LIFECYCLE.md). APP and accepted N2–N6 source remain unchanged.

Residual R1/R2 correction resolves committed-but-uncertain registration before manual cleanup and fences Chatwoot lifecycle commands across awaits. The final targeted audit also fences the settings websocket restart. See [reproductions, ownership outcomes, regression results and runtime gates](GROUPS-WAVE1-RESIDUAL-LIFECYCLE.md).

R3 captures profile/privacy operation authority before awaits and passes it through awaited reload. The same-class audit also fences delayed instance creation and startup failure handling. See [R3 reproductions, regressions and runtime gates](GROUPS-WAVE1-R3-LIFECYCLE.md) and [the complete lifecycle call inventory](GROUPS-WAVE1-R3-LIFECYCLE-AUDIT.md). APP remains frozen.

## Routing invariant

Managed `nexi-wa-` group traffic terminates before placeholder/history requests, transcription, customer persistence, Chatwoot, every chatbot dispatcher (including n8n), generic webhook/event transports or financial interpretation. Storage or proof failure never permits fallback. Ordinary direct paths and accepted Financial Delivery/identity patches remain present. Unmanaged group traffic retains its transport, with the rc13 participant adapter corrected to GroupParticipant objects.

The successfully decrypted raw Baileys stanza is durably admitted before `cleanMessage`, Signal key commit and delivery receipt. Server-queued live CB deliveries are eligible, including the offline flag; history sync and public copies cannot acquire this provenance. Strict numeric `@g.us` group identity is distinct from direct PN/LID, status/broadcast and newsletters. Community/announcement entities are rejected at discovery and metadata admission. Devices are stripped from participant addresses without converting LID numbers into phones; aliases require actual upstream fields. Quotes do not establish sender authority.

Only text and safe unsupported placeholders are projected. No media download/transport, view-once/ephemeral bodies, raw payload archive, quoted content or historical import is added. Raw protocol revoke/edit events emit reference-only redactions, preventing stale text restoration in APP. Public membership/metadata/photo changes invalidate snapshots; they never invent join/leave history. Raw local-account removal deauthorizes ingress and the APP room.

## Dedicated control

`POST /nexi/groups/control/:instanceName` uses existing API-key authentication plus per-instance HMAC of `groups-control:v1:<base64url claims>`. Claims bind version, account/channel, instance name/id, binding generation, operation, exact parameters and a maximum 60-second expiry. Account must match the verified APP webhook configuration. A connected proved session is required.

* `bootstrap`: single-use APP nonce, monotonic generation, immutable owner. Control and `group.session.proved` outbox entry commit atomically. No Contact/Conversation/direct attendance is required.
* `catalog`: `groupFetchAllParticipating`, max 2,000 group descriptors, 15-minute persisted instance/session cache. No photos or per-group metadata fanout. Stale is explicit.
* `room`: signed group JID, enabled state, room generation and metadata revision. Enable fetches one metadata snapshot, validates GroupParticipant objects and local account membership. CAS prevents an older enable/refresh from replacing a newer disable. Admission and canonical snapshot enqueue commit together.

Generic managed `/group` operations and group targets in message/chat/call routes are denied before content/media/network handling. Chatwoot outbound also denies such targets. `sendMessageWithTyping`, Baileys relay and native plaintext resend add final group denial. There is no GroupSendExecution, human sending, media transport or upstream mark-read in this wave.

## Durable delivery and cache

`NexiGroupControl` stores exact instance/account/channel/session authority and bounded catalog/room state. `NexiGroupEventOutbox` stores stable event UUID, source identity hash, canonical payload fingerprint and database lease/retry state. Bootstrap/snapshot authority mutations and their events are atomic. Logical source upsert retains the same UUID/body across restart; conflicting content is rejected. Payload is cleared after delivery/permanent rejection while dedupe tombstones remain. Intentional Instance deletion cascades transport control/outbox rows, preserving native deletion behavior; APP retained history is independent.

Worker drains FIFO per instance, max 20 entries/tick, every 15 seconds, 10-second HTTP timeout, 30-second DB lease. Atomic claims recheck due time, state, attempts, age and expired lease. ACK/retry updates require the current unexpired token; there is no process-local workers Set. Retries renew only the authenticated dispatch timestamp, preserve exact event ID/body and never resend WhatsApp. Backoff is 5–300 seconds, at most 12 attempts or 24 hours. Exhaustion quarantines visibly and clears canonical payload; opaque source/fingerprint/UUID tombstones remain. A global sweep includes disconnected/unloaded instances. Permanent 4xx denial is terminal.

Generic group metadata cache keys now include instance ID, proved session fingerprint and group JID; stale reads return refreshed data instead of the previous stale object. Dedicated discovery avoids the legacy photo fanout altogether. No aggressive WhatsApp polling is introduced.

Operational logs use fixed safe codes for technical Group provenance before raw packet/decrypt/contact/call logging, including offline Signal and key-store operations. The pinned receive hook nests decrypt and awaited canonical admission in the same outer Signal key transaction. Canonical SQL commits before Signal consumption and WhatsApp receipt. Admission failure rolls back key writes and skips fallback ACK/NACK. Only the exact originating socket may suspend; its registered owner token fences delayed status writes. A recoverable 503/connecting reason triggers bounded storage-aware recovery, including restart, with a rollback-only admission write probe before reconnect. Ordinary 408/reconnect behavior remains unchanged. Successful enqueue followed by process death retains the same source/event UUID. The WeakMap only bridges immediate projection, never durability. No guarantee of indefinite WhatsApp server retention or historical import is made. See [second correction semantics and evidence](GROUPS-WAVE1-CORRECTIONS-2.md); [first correction evidence](GROUPS-WAVE1-CORRECTIONS.md) describes the preceding historical state.

## Migrations, build and verification

`patch-groups-source.mjs` applies after accepted Financial Delivery, trusted identity and native retry patches, checks unique pinned anchors, updates all three Prisma schemas before generation and keeps the helper external so private provenance is shared. New PostgreSQL/MySQL migrations are copied into the existing image migration trees; psql_bouncer retains the accepted PostgreSQL migration/bundle strategy. Runtime assertions require both compiled Prisma models and the routing gates for built providers.

Run `node --test groups-wave1.test.cjs nexi-transport.test.cjs identity-foundation-source.test.cjs financial-delivery-source.test.cjs bundle-patch.test.cjs runtime-model.test.cjs redis-lua.integration.test.cjs`. Tests reconstruct pinned source in an isolated temporary directory, apply the combined patches, execute the real decrypt/chatbot functions, validate every Prisma schema using existing dependencies, and cover authority, dedupe, crash/lease/retry, local leave, cache fanout and managed outbound denial. They never call live WhatsApp or install dependencies.

Local verification does not build Docker/provider bundles, apply a migration to a real database or run the Redis-dependent case. Strict review must build the actual provider image and execute its compiled-model assertions, apply migrations to isolated PostgreSQL/MySQL databases, and exercise real transaction races before promotion. The APP companion also has unexecuted Rails/PostgreSQL integration specs because its bundle is unavailable locally.
