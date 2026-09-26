'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createReplayLedger } = require('./nexi-transport.cjs');

test('real Redis Lua status replies support claim, reclaim, dispatch and finalization',
  { skip: !process.env.NEXI_TEST_REDIS_URL }, async () => {
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.NEXI_TEST_REDIS_URL });
    client.on('error', () => {});
    const keys = [];
    try {
      await client.connect();
      // This focused test exercises real EVAL/reply conversion without changing test Redis durability settings.
      const adapter = { get isReady() { return client.isReady; },
        eval: (...args) => client.eval(...args),
        configGet: async () => ({ 'maxmemory-policy': 'noeviction', appendonly: 'yes', appendfsync: 'always' }) };
      const prefix = `nexi-lua-test:${randomUUID()}`;
      const first = createReplayLedger({ client: adapter, prefix, reservedLeaseMs: 500 });
      const second = createReplayLedger({ client: adapter, prefix, reservedLeaseMs: 500 });
      const raw = Buffer.from('test-only-body');
      const scope = ['nexi-wa-lua-test', '4', '13'];

      const deliveryA = randomUUID();
      const claimA = await first.claim(...scope, deliveryA, raw);
      assert.equal(claimA.kind, 'claimed');
      keys.push(claimA.key);
      assert.equal((await second.claim(...scope, deliveryA, raw)).state, 'active_reserved');
      await first.beginDispatch(claimA);
      assert.equal((await second.claim(...scope, deliveryA, raw)).state, 'dispatching');
      await first.finish(claimA, 'completed');
      assert.equal((await second.claim(...scope, deliveryA, raw)).state, 'completed');

      const deliveryB = randomUUID();
      const staleOwner = await first.claim(...scope, deliveryB, raw);
      assert.equal(staleOwner.kind, 'claimed');
      keys.push(staleOwner.key);
      await new Promise((resolve) => setTimeout(resolve, 650));
      const newOwner = await second.claim(...scope, deliveryB, raw);
      assert.equal(newOwner.kind, 'claimed');
      await assert.rejects(first.beginDispatch(staleOwner));
      await second.beginDispatch(newOwner);
      await assert.rejects(first.finish(staleOwner, 'completed'));
      await second.finish(newOwner, 'ambiguous');
      assert.equal((await first.claim(...scope, deliveryB, raw)).state, 'ambiguous');
    } finally {
      if (client.isReady) await Promise.all(keys.map((key) => client.del(key)));
      if (client.isOpen) await client.quit();
    }
  });
