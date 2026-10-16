'use strict';
require('./attendance-test-network-trap.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const attendance = require('./nexi-attendance.cjs');
const authority = require('./nexi-attendance-authority.cjs');
const groups = require('./nexi-groups.cjs');
const { memory, original, fixture } = require('./attendance-authority-test-support.cjs');
const { withSocket } = require('./attendance-socket-test-support.cjs');
const stanza = f => ({ tag: 'message', attrs: { id: f.repo.row().externalId, to: f.repo.row().recipient } });
const dispatch = f => authority.dispatchStart(f.source, f.repo.row().id, fixture.material.consumption_id, stanza(f));
async function consumed() { const f = memory(); await authority.consumption(f.source, original()); return f; }

test('fixture obtains verified public attestation, signed APP context and database socket owner through real registration', async () => {
  const f = await consumed();
  await withSocket(f, async registration => {
    const snapshot = await attendance.captureContextSnapshot(f.source, registration.owner);
    assert.equal(attendance.writerIsolation(f.source, snapshot.context), true);
    assert.ok(attendance.captureContextCurrent(snapshot));
    assert.equal(registration.instance.nexiGroupsSocketOwner, registration.owner.token);
    const proof = [...registration.events.values()];
    assert.equal(proof.length, 1); assert.equal(proof[0].eventType, 'attendance.session.proved');
    assert.equal(proof[0].body.data.provenance, 'verified_restored_account');
    assert.equal(proof[0].body.data.session_identity, f.repo.row().sessionIdentity);
    assert.equal((await dispatch(f)).started, true);
  });
});

test('a replaced local socket cannot reuse the registered owner or snapshot', async () => {
  const f = await consumed();
  await withSocket(f, async registration => {
    f.source.service.client = { ...f.source.service.client };
    assert.equal(groups.lifecycleCurrent(registration.owner), false);
    await assert.rejects(dispatch(f), { code: 'nexi_attendance_capture_socket_mismatch' });
    assert.equal(f.repo.row().dispatchStartedAt, null);
  });
});

test('a foreign database owner fences an otherwise valid local socket before dispatch CAS', async () => {
  const f = await consumed();
  await withSocket(f, async registration => {
    registration.instance.nexiGroupsSocketOwner = 'aaaaaaaa-1111-4111-8111-111111111111';
    await assert.rejects(dispatch(f), { code: 'nexi_attendance_dispatch_fenced' });
    assert.equal(f.repo.row().dispatchStartedAt, null);
  });
});

for (const [name, options, code] of [
  ['invalid APP signature', { badSignature: true }, 'nexi_attendance_context_invalid'],
  ['cross-instance APP context', { context: value => ({ ...value, instance_id: 'aaaaaaaa-1111-4111-8111-111111111111' }) }, 'nexi_attendance_context_invalid'],
  ['cross-provider APP context', { context: value => ({ ...value, provider: 'other-provider' }) }, 'nexi_attendance_context_invalid'],
  ['unverified account signature', { badAttestation: true }, 'nexi_attendance_writer_isolation_unproved'],
  ['different writer epoch', { context: value => ({ ...value, writer_epoch: value.writer_epoch + 1 }) }, 'nexi_attendance_dispatch_fenced'],
]) test(`${name} cannot acquire dispatch authority`, async () => {
  const f = await consumed();
  await withSocket(f, async () => {
    await assert.rejects(dispatch(f), { code });
    assert.equal(f.repo.row().dispatchStartedAt, null); assert.equal(f.repo.row().outcomeUnknown, false);
  }, options);
});

test('registered and attested socket still cannot send the reserved ID without a released capability', async () => {
  const f = await consumed();
  await withSocket(f, async registration => {
    await assert.rejects(attendance.assertNode(registration.config, stanza(f)), { code: 'nexi_attendance_dispatch_disabled_wave1b' });
    assert.equal(f.repo.row().dispatchStartedAt, null);
  });
});

test('fixture rollback cannot overwrite another transaction commit', async () => {
  const f = memory(); let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; });
  const resumed = new Promise(resolve => { resume = resolve; });
  const first = f.repo.$transaction(async tx => { enter(); await resumed; tx.row().testCommit = 'durable'; });
  await entered;
  const second = f.repo.$transaction(async tx => { assert.equal(tx.row().testCommit, 'durable'); tx.row().testCommit = 'rolled-back'; throw Error('SYNTHETIC_ROLLBACK'); });
  const rejected = assert.rejects(second, /SYNTHETIC_ROLLBACK/);
  resume(); await first; await rejected;
  assert.equal(f.repo.row().testCommit, 'durable');
});
