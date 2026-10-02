# NEXI Groups V1 — authority and inbound foundation

Overlay baseline: `553a888ececf97bb60a80c1a5987185bbd56d0de`. APP baseline: `04fef75df45fa3eb86335c7d7f13c4c78b3dbc91`. Docker source remains pinned to `e273b904d53f5726970fd6a244ed9caa61dfeb9a` with Baileys `7.0.0-rc13`.

## Routing invariant

Managed `nexi-wa-` group traffic terminates before placeholder/history requests, transcription, customer persistence, Chatwoot, every chatbot dispatcher (including n8n), generic webhook/event transports or financial interpretation. Storage or proof failure never permits fallback. Ordinary direct paths and accepted Financial Delivery/identity patches remain present. Unmanaged group traffic retains its transport, with the rc13 participant adapter corrected to GroupParticipant objects.

The successfully decrypted raw Baileys stanza is projected before `cleanMessage`; private object provenance is consumed by the dedicated ingress. Offline/history/public copies cannot acquire it. Strict numeric `@g.us` group identity is distinct from direct PN/LID, status/broadcast and newsletters. Community/announcement entities are rejected at discovery and metadata admission. Devices are stripped from participant addresses without converting LID numbers into phones; aliases require actual upstream fields. Quotes are same-room references and cannot replace sender authority.

Only text and safe unsupported placeholders are projected. No media download/transport, view-once/ephemeral bodies, raw payload archive, quoted content or historical import is added. Raw protocol revoke/edit events emit reference-only redactions, preventing stale text restoration in APP. Public membership/metadata/photo changes invalidate snapshots; they never invent join/leave history. Raw local-account removal deauthorizes ingress and the APP room.

## Dedicated control

`POST /nexi/groups/control/:instanceName` uses existing API-key authentication plus per-instance HMAC of `groups-control:v1:<base64url claims>`. Claims bind version, account/channel, instance name/id, binding generation, operation, exact parameters and a maximum 60-second expiry. Account must match the verified APP webhook configuration. A connected proved session is required.

* `bootstrap`: single-use APP nonce, monotonic generation, immutable owner. Control and `group.session.proved` outbox entry commit atomically. No Contact/Conversation/direct attendance is required.
* `catalog`: `groupFetchAllParticipating`, max 2,000 group descriptors, 15-minute persisted instance/session cache. No photos or per-group metadata fanout. Stale is explicit.
* `room`: signed group JID, enabled state, room generation and metadata revision. Enable fetches one metadata snapshot, validates GroupParticipant objects and local account membership. CAS prevents an older enable/refresh from replacing a newer disable. Admission and canonical snapshot enqueue commit together.

Generic managed `/group` operations and group targets in message/chat/call routes are denied before content/media/network handling. Chatwoot outbound also denies such targets. `sendMessageWithTyping`, Baileys relay and native plaintext resend add final group denial. There is no GroupSendExecution, human sending, media transport or upstream mark-read in this wave.

## Durable delivery and cache

`NexiGroupControl` stores exact instance/account/channel/session authority and bounded catalog/room state. `NexiGroupEventOutbox` stores stable event UUID, source identity hash, canonical payload fingerprint and database lease/retry state. Bootstrap/snapshot authority mutations and their events are atomic. Logical source upsert retains the same UUID/body across restart; conflicting content is rejected. Payload is cleared after delivery/permanent rejection while dedupe tombstones remain. Intentional Instance deletion cascades transport control/outbox rows, preserving native deletion behavior; APP retained history is independent.

Worker drains FIFO per instance, max 20 entries/tick, every 15 seconds, 10-second HTTP timeout, 30-second DB lease. Retries renew only the authenticated dispatch timestamp, preserve exact event ID/body and never resend a WhatsApp message. Temporary APP 503 and network failures back off (5–300 seconds). Permanent 4xx denial is terminal. No local-memory replay ledger exists; the worker Set is an efficiency guard only.

Generic group metadata cache keys now include instance ID, proved session fingerprint and group JID; stale reads return refreshed data instead of the previous stale object. Dedicated discovery avoids the legacy photo fanout altogether. No aggressive WhatsApp polling is introduced.

Operational logs contain fixed safe error codes. A DB failure before enqueue emits `nexi_groups_ingress_unavailable` and discards group fallthrough. Durable restart guarantees begin at successful enqueue; a pre-enqueue outage can lose a Baileys-acknowledged message. No zero-loss outage/history guarantee is claimed.

## Migrations, build and verification

`patch-groups-source.mjs` applies after accepted Financial Delivery, trusted identity and native retry patches, checks unique pinned anchors, updates all three Prisma schemas before generation and keeps the helper external so private provenance is shared. New PostgreSQL/MySQL migrations are copied into the existing image migration trees; psql_bouncer retains the accepted PostgreSQL migration/bundle strategy. Runtime assertions require both compiled Prisma models and the routing gates for built providers.

Run `node --test groups-wave1.test.cjs nexi-transport.test.cjs identity-foundation-source.test.cjs financial-delivery-source.test.cjs bundle-patch.test.cjs runtime-model.test.cjs redis-lua.integration.test.cjs`. Tests reconstruct pinned source in an isolated temporary directory, apply the combined patches, execute the real decrypt/chatbot functions, validate every Prisma schema using existing dependencies, and cover authority, dedupe, crash/lease/retry, local leave, cache fanout and managed outbound denial. They never call live WhatsApp or install dependencies.

Local verification does not build Docker/provider bundles, apply a migration to a real database or run the Redis-dependent case. Strict review must build the actual provider image and execute its compiled-model assertions, apply migrations to isolated PostgreSQL/MySQL databases, and exercise real transaction races before promotion. The APP companion also has unexecuted Rails/PostgreSQL integration specs because its bundle is unavailable locally.
