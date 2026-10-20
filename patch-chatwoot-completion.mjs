import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function patchChatwootCompletion(source) {
  const send = `    try {
        return await axios_1.default.request(requestConfig);
    }
    catch (error) {
        const axiosError = error;
        if (axiosError.response) {
            return axiosError.response;
        }
        throw error;
    }`;
  if (source.split(send).length !== 2) throw new Error('Pinned SDK HTTP diagnostic anchor changed');
  source = source.replace(send, `    const nexiMessagePost = options.method === 'POST' &&
        options.url === '/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages';
    const nexiIngress = nexiMessagePost ? require('/evolution/nexi-ingress.cjs') : null;
    nexiIngress?.creationHttp('sdk_message_post', 'request_started');
    try {
        const response = await axios_1.default.request(requestConfig);
        nexiIngress?.creationHttp('sdk_message_post', 'http_response', response.status);
        return response;
    }
    catch (error) {
        const axiosError = error;
        if (axiosError.response) {
            nexiIngress?.creationHttp('sdk_message_post', 'http_response', axiosError.response.status);
            return axiosError.response;
        }
        nexiIngress?.creationHttp('sdk_message_post', 'transport_error', undefined, error);
        throw error;
    }`);
  const before = 'const request = (config, options) => {\n    return new CancelablePromise_1.CancelablePromise(async (resolve, reject, onCancel) => {';
  const after = `const request = (config, options) => {
    const nexiIngress = options.method === 'POST' &&
        options.url === '/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages'
        ? require('/evolution/nexi-ingress.cjs') : null;
    let nexiStep = 'sdk_url';
    let transportSettled;
    const completion = new Promise(resolve => { transportSettled = resolve; });
    const operation = new CancelablePromise_1.CancelablePromise(async (resolve, reject, onCancel) => {`;
  const tail = `        catch (error) {
            reject(error);
        }
    });
};
exports.request = request;`;
  if (source.split(before).length !== 2 || source.split(tail).length !== 2) throw new Error('Pinned SDK completion anchors changed');
  const steps = [
    ['            const url = getUrl(config, options);', 'sdk_url'],
    ['            const formData = getFormData(options);', 'sdk_form'],
    ['            const body = getRequestBody(options);', 'sdk_body'],
    ['            const headers = await getHeaders(config, options, formData);', 'sdk_headers'],
    ['                const response = await sendRequest(config, options, url, body, formData, headers, onCancel);', 'sdk_send'],
    ['                const responseBody = getResponseBody(response);', 'sdk_response'],
    ['                resolve(result.body);', 'sdk_return'],
  ];
  for (const [anchor, step] of steps) {
    if (source.split(anchor).length !== 2) throw new Error('Pinned SDK preparation anchor changed');
    const indent = anchor.match(/^ */)[0];
    source = source.replace(anchor, `${indent}nexiStep = '${step}';\n${indent}nexiIngress?.creationStep(nexiStep);\n${anchor}`);
  }
  return source.replace(before, after).replace(tail, `        catch (error) {
            nexiIngress?.creationStep(nexiStep, error);
            reject(error);
        }
        finally {
            transportSettled();
        }
    });
    // cancel() can reject the public facade before Axios settles. Track the
    // actual request executor separately; this promise never rejects.
    Object.defineProperty(operation, 'nexiTransportSettled', { value: completion });
    return operation;
};
exports.request = request;`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || '/evolution';
  const sdk = path.join(root, 'node_modules/@figuro/chatwoot-sdk');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.packages['node_modules/@figuro/chatwoot-sdk']?.version !== '1.1.17' ||
      lock.packages['node_modules/@figuro/chatwoot-sdk/node_modules/axios']?.version !== '0.27.2' ||
      JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8')).version !== '1.1.17' ||
      JSON.parse(fs.readFileSync(path.join(sdk, 'node_modules/axios/package.json'), 'utf8')).version !== '0.27.2')
    throw new Error('Ingress requires pinned SDK 1.1.17 / Axios 0.27.2');
  const hashes = {
    'dist/index.js': '41f18559644a5bb659d2735c44b36f6926f6bba3da7886b7a8cda9fe1c4f2057',
    'dist/core/request.js': '58cb9323b1e62b35bcb92dc10abd915860608edd3e8b16ef392a4da544ff5bf7',
    'dist/core/CancelablePromise.js': 'c049e0921d4f9b65b1efd8175edbdd3920ae22791fa1497a6f97f07e910248b3',
    'dist/services/Messages.js': '57b9f7157b9ef06c8762c1749b975e6a1fb1b2eca2bc005fefa63bf77b4559dc',
  };
  for (const [file, digest] of Object.entries(hashes)) {
    const bytes = fs.readFileSync(path.join(sdk, file), 'utf8').replaceAll('\r\n', '\n');
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`Pinned SDK changed: ${file}`);
  }
  const target = path.join(sdk, 'dist/core/request.js');
  fs.writeFileSync(target, patchChatwootCompletion(fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n')));
}
