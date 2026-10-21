'use strict';
require('./attendance-test-network-trap.cjs');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const attendance = require('./nexi-attendance.cjs');
const groups = require('./nexi-groups.cjs');

// Test-only APP transport and repository. All security functions below are the
// production implementations; no guard, verifier, CAS or lifecycle is replaced.
// Top-level tests use Node's default sequential execution within each process.
async function registerSocket(f, t, options = {}) {
  const service = f.source.service, repo = f.repo, socket = service.client;
  const previousFetch = global.fetch;
  const context = { ...repo.row().authority, barrier_state: 'active', physical_dispatch: true,
    isolation_cutover: true, writer_protocol_version: 2 };
  const contexts = new Map(), events = new Map(), requests = [];
  const instance = { id: service.instanceId, name: service.instance.name, nexiGroupsSocketOwner: null };
  repo.instance = {
    async findUnique({ where }) { return where.id === instance.id ? { ...instance } : null; },
    async updateMany({ where, data }) {
      if (!Object.entries(where).every(([key, value]) => instance[key] === value)) return { count: 0 };
      Object.assign(instance, data); return { count: 1 };
    },
  };
  repo.webhook = { async findUnique({ where }) {
    assert.equal(where.instanceId, service.instanceId);
    return { enabled: true, url: 'https://synthetic.invalid/webhooks/nexi/channels/evolution', headers: {
      'X-Nexi-Chatwoot-Account-Id': String(context.account_id), 'X-Nexi-Chatwoot-Inbox-Id': String(context.inbox_id),
    } };
  } };
  repo.nexiManagedTransportContext = {
    async findFirst() { return [...contexts.values()].at(-1) || null; },
    async findUnique({ where }) { return contexts.get(where.fingerprint) || null; },
    async create({ data }) { contexts.set(data.fingerprint, data); return data; },
  };
  repo.nexiAttendanceEventOutbox = {
    async findUnique({ where }) { return events.get(where.instanceId_sourceKey.sourceKey) || null; },
    async create({ data }) { events.set(data.sourceKey, data); return data; },
  };
  repo.attendanceReceiptRepository = () => ({});
  service.prismaRepository = repo;
  const config = { auth: { creds: socket.authState.creds }, logger: { level: 'silent', warn() {} } };
  let closed = false;
  let registeredToken;
  const close = () => { if (!closed) { closed = true; global.fetch = previousFetch; attendance.clearInstanceDiagnostics(service); } };
  t.after(close);
  global.fetch = async (url, request) => {
    assert.equal(String(url), 'https://synthetic.invalid/webhooks/nexi/channels/evolution');
    assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
    const body = JSON.parse(request.body), data = body.data, headers = request.headers;
    assert.ok(['attendance.context.request', 'attendance.writer.context.request'].includes(body.event));
    assert.equal(body.instance, service.instance.name); assert.equal(headers['X-Instance-ID'], service.instanceId);
    assert.equal(data.session_identity, require('./nexi-identity.cjs').sessionFingerprint(config.auth.creds));
    const secret = createHmac('sha256', process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET).update(`event:${service.instance.name}`).digest();
    const signature = createHmac('sha256', secret).update(`${headers['X-Nexi-Event-Timestamp']}.${headers['X-Nexi-Event-Id']}.${service.instance.name}.${service.instanceId}.${attendance.canonicalBytes(body)}`).digest('hex');
    assert.equal(headers['X-Nexi-Event-Signature'], `sha256=${signature}`);
    if (body.event === 'attendance.writer.context.request') assert.equal(data.socket_owner, registeredToken);
    const reply = options.context ? options.context({ ...context }, data) : context;
    const claims = Buffer.from(attendance.canonicalBytes({ ...reply, nonce: data.nonce })).toString('base64url');
    requests.push({ event: body.event, socket_owner: data.socket_owner, isolated_authorization_id: data.isolated_authorization_id });
    const signed = createHmac('sha256', secret).update(`attendance-context:v1:${claims}`).digest('hex');
    return { ok: true, status: 200, json: async () => ({ claims, signature: options.badSignature ? '0'.repeat(64) : signed }) };
  };
  try {
    await attendance.configure(service, config);
    await groups.installAdmissionSocket(service, config, () => socket);
    attendance.trackSocket(service.client, config);
    const owner = groups.lifecycleCapture(service);
    assert.ok(groups.lifecycleCurrent(owner)); assert.equal(owner.token, instance.nexiGroupsSocketOwner);
    registeredToken = owner.token;
    // Locally generated account signature, verified by libsignal and the same
    // protobuf/prefix callback used by the pinned rc13 restored-account hook.
    const curve = require('libsignal/src/curve.js');
    const lib = path.dirname(require.resolve('baileys'));
    const { proto } = await import(pathToFileURL(path.resolve(lib, '../WAProto/index.js')));
    const { WA_ADV_ACCOUNT_SIG_PREFIX, WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX } = await import(pathToFileURL(path.join(lib, 'Defaults/index.js')));
    const key = curve.generateKeyPair(), creds = config.auth.creds;
    const details = Buffer.from(proto.ADVDeviceIdentity.encode({ rawId: 1, timestamp: 1, keyIndex: 1 }).finish());
    creds.account = { accountSignatureKey: key.pubKey.subarray(1), details,
      accountSignature: curve.calculateSignature(key.privKey, Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, details, creds.signedIdentityKey.public])) };
    if (options.badAttestation) creds.account.accountSignature[0] ^= 1;
    await attendance.observePublicAccount(config, creds, attendance.verifyPublicAccountSignature,
      bytes => proto.ADVDeviceIdentity.decode(bytes).deviceType === proto.ADVEncryptionType.HOSTED
        ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX : WA_ADV_ACCOUNT_SIG_PREFIX, 'verified_restored_account');
    f.socketRegistration = { config, owner, instance, requests, events, context, close };
    return f.socketRegistration;
  } catch (error) { close(); throw error; }
}

async function withSocket(f, work, options) {
  let close;
  try { await registerSocket(f, { after: fn => { close = fn; } }, options); return await work(f.socketRegistration); }
  finally { close?.(); }
}
module.exports = { registerSocket, withSocket };
