'use strict';

const assert = require('node:assert/strict');

const SEND_NODE = '    const sendNode = async (frame) => {';
const SEND_NODE_END = '\n    };\n    /**\n     * Wait for a message with a certain tag';

module.exports = function assertProtectedSendNode(source) {
  assert.equal(source.split(SEND_NODE).length - 1, 1, 'one protected sendNode');
  const start = source.indexOf(SEND_NODE);
  const end = source.indexOf(SEND_NODE_END, start);
  assert.ok(start >= 0 && end > start, 'complete protected sendNode region');
  const body = source.slice(start, end + '\n    };'.length);

  const snapshotCall = 'const nexiFrame = nexiAttendance.snapshotFrame(config, frame);';
  const assertionCall = 'await nexiAttendance.assertNode(config, nexiFrame);';
  const loggingCall = "logger.trace({ xml: binaryNodeToString(nexiFrame), msg: 'xml send' });";
  const encodingCall = 'const buff = encodeBinaryNode(nexiFrame);';
  const physicalSend = 'return sendRawMessage(buff);';

  const snapshot = body.indexOf(snapshotCall);
  const assertion = body.indexOf(assertionCall);
  const logging = body.indexOf(loggingCall);
  const encoding = body.indexOf(encodingCall);
  const send = body.indexOf(physicalSend);
  assert.ok(snapshot >= 0, 'final snapshot captured');
  assert.ok(snapshot < assertion, 'snapshot precedes async Attendance assertion');
  assert.ok(assertion < logging, 'Attendance assertion precedes logging');
  assert.ok(logging < encoding, 'logging precedes encoding');
  assert.ok(encoding < send, 'encoding precedes physical send');
  assert.equal(body.split(encodingCall).length - 1, 1, 'one snapshot encoder');

  // After snapshot capture, no expression may read the caller-owned frame.
  // This also rejects caller-frame logging and encoding in the protected region.
  assert.doesNotMatch(body.slice(snapshot + snapshotCall.length), /\bframe\b/,
    'caller-owned frame is not read after final snapshot capture');
};
