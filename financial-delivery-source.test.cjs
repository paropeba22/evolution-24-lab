'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const revision = 'e273b904d53f5726970fd6a244ed9caa61dfeb9a';
const files = [
  'src/validate/message.schema.ts',
  'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts',
  'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts',
];
const hashes = [
  '32c39bf02b7687000fd6ffb0aba23c4f301de3f46e651a020e6caffad85fc57c',
  '83860d7672f70e7603eb89ce4a797c9243f8c5595e0634713684b3d7241b3c7d',
  'e9249cd2783b8ad1d7e88c238b3fe506ea39aa427696288db0488e7e4d993e5d',
];

function withTransformedSource(run) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'nexi-financial-source-'));
  const snapshot = path.join(__dirname, '.financial-upstream');
  const checkout = process.env.EVOLUTION_UPSTREAM_SOURCE || path.join(__dirname, '../evolution-upstream');
  try {
    files.forEach((file, index) => {
      let source;
      if (fs.existsSync(snapshot)) {
        assert.equal(fs.readFileSync(path.join(snapshot, 'REVISION'), 'utf8'), revision);
        source = fs.readFileSync(path.join(snapshot, file), 'utf8');
      } else {
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), revision);
        // Read committed pristine bytes, even if an unrelated schema is dirty.
        source = execFileSync('git', ['show', `${revision}:${file}`], { cwd: checkout, encoding: 'utf8' });
      }
      source = source.replaceAll('\r\n', '\n');
      assert.equal(createHash('sha256').update(source).digest('hex'), hashes[index]);
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    });
    execFileSync(process.execPath, [path.join(__dirname, 'patch-financial-delivery-source.mjs'), root]);
    return run(root, files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')), checkout);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('mandatory pristine pinned source transformation: managed copy/url and unmanaged copy/url', () => {
  withTransformedSource((root, [schema, mapper], checkout) => {
    try {
      assert.match(schema, /copyCode: \{ type: 'string' \}/);
      const guard = mapper.match(/(const managedCta =[\s\S]*?;)\n\s*if \(managedCta\) return;/);
      assert.ok(guard);
      const isManagedCta = new Function('instance', 'body', 'isInteractiveButtonMessage', `${guard[1]} return managedCta;`);
      for (const type of ['cta_copy', 'cta_url']) {
        const body = { key: { fromMe: true }, message: { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: type }] } } } };
        assert.equal(isManagedCta({ instanceName: 'nexi-wa-test' }, body, true), true);
        assert.equal(isManagedCta({ instanceName: 'other-instance' }, body, true), false);
        assert.equal(isManagedCta({ instanceName: 'nexi-wa-test' }, { ...body, key: { fromMe: false } }, true), false);
      }
      assert.match(mapper, /for \(const button of buttons\) \{/);
      assert.doesNotMatch(mapper, /New message received - Instance: \$\{JSON\.stringify\(body/);
      assert.doesNotMatch(mapper, /Interactive Button Message: ' \+ JSON\.stringify\(buttons\)/);
      // Channels' receiveWebhook source is untouched, preserving its exact
      // bundle anchors (the anti-echo fix lives in its existing route helper).
      const pristine = fs.existsSync(path.join(__dirname, '.financial-upstream'))
        ? fs.readFileSync(path.join(__dirname, '.financial-upstream', files[1]), 'utf8')
        : execFileSync('git', ['show', `${revision}:${files[1]}`], { cwd: checkout, encoding: 'utf8' });
      const receive = (source) => source.replaceAll('\r\n', '\n').split('  public async receiveWebhook(')[1].split('  private async updateChatwootMessageId(')[0];
      assert.equal(receive(mapper), receive(pristine));
      const repeat = spawnSync(process.execPath, [path.join(__dirname, 'patch-financial-delivery-source.mjs'), root], { encoding: 'utf8' });
      assert.notEqual(repeat.status, 0, 'patching transformed or divergent source fails closed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

test('actual transformed sendMessageWithTyping redacts persistence exception, logs, response and diagnostics', async () => {
  let cleanup;
  try {
    const Subject = withTransformedSource((root, [, , baileys], checkout) => {
      cleanup = root;
      const ts = require(require.resolve('typescript', { paths: [__dirname, checkout] }));
      const source = baileys.slice(baileys.indexOf('  private async sendMessageWithTyping<T = proto.IMessage>('), baileys.indexOf('  // Instance Controller'));
      const result = ts.transpileModule(`class Subject { ${source} }; return Subject;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
      });
      assert.equal(result.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
      const financial = require('./nexi-financial-transport.cjs');
      class BadRequestException {
        constructor(...message) { throw { status: 400, error: 'Bad Request', message }; }
      }
      return new Function('require', 'BadRequestException', 'isJidGroup', 'Long', 'Events', result.outputText)(
        (name) => { assert.equal(name, '/evolution/nexi-financial-transport.cjs'); return financial; },
        BadRequestException, () => false, { isLong: () => false }, { SEND_MESSAGE: 'send.message' },
      );
    });
    for (const type of ['cta_copy', 'cta_url']) {
      for (const scenario of [
        { managed: true, failPersistence: true }, { managed: true, failPersistence: false },
        { managed: false, failPersistence: true }, { managed: false, failPersistence: false },
      ]) {
        const { managed, failPersistence } = scenario;
        const captured = [];
        const subject = new Subject();
        subject.instance = { name: managed ? 'nexi-wa-test' : 'unmanaged-instance' };
        subject.instanceId = 'safe-instance-id';
        subject.logger = { verbose: (value) => captured.push(value), error: (value) => captured.push(value) };
        subject.whatsappNumber = async () => [{ exists: true, jid: '5511999999999@s.whatsapp.net' }];
        const message = { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: type,
          buttonParamsJson: JSON.stringify({ copy_code: 'FINANCIAL_SECRET_NEVER_LOG', copyCode: 'FINANCIAL_SECRET_NEVER_LOG',
            url: 'https://example.test/FINANCIAL_SECRET_NEVER_LOG' }) }] } } };
        let sent = 0;
        subject.sendMessage = async () => { sent++; return { key: { id: 'safe-delivery-id', fromMe: true }, message }; };
        subject.prepareMessage = (value) => value;
        subject.configService = { get: (name) => name === 'DATABASE' ? { SAVE_DATA: { NEW_MESSAGE: true } } : { ENABLED: false } };
        subject.localWebhook = { enabled: false };
        subject.sendDataWebhook = (_event, value) => captured.push(value);
        subject.prismaRepository = { message: { create: async (args) => {
          captured.push(args);
          if (failPersistence) throw Object.assign(new Error('Prisma args buttonParamsJson copy_code copyCode FINANCIAL_SECRET_NEVER_LOG'), { code: 'P2002' });
          return { id: 'db-id' };
        } } };
        let response;
        let propagated;
        try { response = await subject.sendMessageWithTyping('5511999999999', message, {}); } catch (error) { propagated = error; }
        assert.equal(sent, 1, 'persistence failure happens after external acceptance');
        const diagnostics = JSON.stringify({ captured, response, propagated });
        if (!managed) {
          // Preserve upstream unmanaged contracts for both copy and URL.
          assert.match(diagnostics, /FINANCIAL_SECRET_NEVER_LOG/);
          if (failPersistence) assert.match(propagated.message[0], /FINANCIAL_SECRET_NEVER_LOG/);
          else assert.equal(response.message, message);
          continue;
        }
        assert.doesNotMatch(diagnostics, /FINANCIAL_SECRET_NEVER_LOG|buttonParamsJson|copy_code|copyCode/);
        if (failPersistence) {
          assert.equal(response, undefined);
          assert.deepEqual(propagated, { status: 400, error: 'Bad Request', message: ['nexi_financial_transport_failed'] });
          assert.deepEqual(captured.at(-1), { code: 'nexi_financial_transport_failed', operation: 'sendButtons',
            instanceId: 'safe-instance-id', deliveryId: 'safe-delivery-id', stage: 'persistence', category: 'persistence', status: 400 });
        } else assert.deepEqual(response, { key: { id: 'safe-delivery-id', fromMe: true } });
      }
    }
  } finally { if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true }); }
});

test('actual transformed asynchronous managed CTA echo cannot log or persist the PIX', async () => {
  let cleanup;
  try {
    const Subject = withTransformedSource((root, [, , baileys], checkout) => {
      cleanup = root;
      const ts = require(require.resolve('typescript', { paths: [__dirname, checkout] }));
      const start = baileys.indexOf("    'messages.upsert': async (");
      const end = baileys.indexOf("    'messages.update': async (", start);
      assert.ok(start >= 0 && end > start);
      const result = ts.transpileModule(`class Subject { messageHandle = { ${baileys.slice(start, end)} } }; return Subject;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
      });
      assert.equal(result.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
      return new Function('require', result.outputText)(() => require('./nexi-financial-transport.cjs'));
    });
    const subject = new Subject();
    subject.instance = { name: 'nexi-wa-test' };
    const captured = [];
    subject.logger = { error: (error) => captured.push(error), warn: (value) => captured.push(value) };
    for (const type of ['cta_copy', 'cta_url']) {
      const message = { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: type,
        buttonParamsJson: 'FINANCIAL_SECRET_NEVER_LOG' }] } } };
      for (const content of [message, { viewOnceMessage: { message } }]) {
        await subject.messageHandle['messages.upsert']({ type: 'notify', messages: [{ key: { fromMe: true }, message: content }] }, {});
      }
    }
    assert.deepEqual(captured, [], 'echo exits before raw logging and Prisma');
  } finally { if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true }); }
});

test('Docker retains pristine files and copies the patcher and runtime helper at deterministic paths', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /patch-financial-delivery-source\.mjs \/evolution --snapshot/);
  assert.match(dockerfile, /COPY patch-financial-delivery-source\.mjs nexi-financial-transport\.cjs \/evolution\//);
  assert.match(dockerfile, /COPY --from=source-builder \/evolution\/nexi-financial-transport\.cjs \/evolution\/nexi-financial-transport\.cjs/);
  assert.match(dockerfile, new RegExp(`git fetch --depth 1 origin ${revision}`));
  // In Docker both provider suites also verify the final transformed bundle.
  // Local source tests remain mandatory when no bundle has been built.
  if (process.env.EVOLUTION_BUNDLE_PATH) {
    const bundle = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH, 'utf8');
    assert.match(bundle, /nexi-p3-chatwoot-transport/);
    assert.match(bundle, /processChatwootWebhook/);
    assert.match(bundle, /nexi-financial-transport\.cjs/);
    assert.match(bundle, /failureMetadata/);
    assert.match(bundle, /nexi_financial_transport_failed/);
    assert.match(bundle, /NEXI financial delivery/);
  }
});
