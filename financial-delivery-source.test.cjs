'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const upstream = process.env.EVOLUTION_UPSTREAM_SOURCE;

test('pinned source patch suppresses managed CTAs and preserves upstream non-managed mapping', { skip: !upstream }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexi-financial-cta-'));
  const files = [
    'src/validate/message.schema.ts',
    'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts',
  ];
  try {
    for (const file of files) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(upstream, file), target);
    }
    execFileSync(process.execPath, [path.join(__dirname, 'patch-financial-delivery-source.mjs'), root]);
    const schema = readFileSync(path.join(root, files[0]), 'utf8');
    const mapper = readFileSync(path.join(root, files[1]), 'utf8');
    assert.match(schema, /copyCode: \{ type: 'string' \}/);
    assert.match(mapper, /button\.name === 'cta_copy' \|\| button\.name === 'cta_url'/);
    assert.match(mapper, /if \(managedCta\) return;/);
    assert.doesNotMatch(mapper, /const cta = body\.key\.fromMe/);
    assert.doesNotMatch(mapper, /PIX da fatura enviado ao cliente|Fatura enviada ao cliente/);
    assert.match(mapper, /for \(const button of buttons\) \{/);
    const guard = mapper.match(/(const managedCta =[\s\S]*?;)\n\s*if \(managedCta\) return;/);
    assert.ok(guard);
    const isManagedCta = new Function('instance', 'body', 'isInteractiveButtonMessage', `${guard[1]} return managedCta;`);
    for (const type of ['cta_copy', 'cta_url']) {
      const body = { key: { fromMe: true }, message: { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: type }] } } } };
      assert.equal(isManagedCta({ instanceName: 'nexi-wa-123' }, body, true), true);
      assert.equal(isManagedCta({ instanceName: 'other-instance' }, body, true), false);
    }
    assert.doesNotMatch(mapper, /New message received - Instance: \$\{JSON\.stringify\(body/);
    assert.doesNotMatch(mapper, /Interactive Button Message: ' \+ JSON\.stringify\(buttons\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
