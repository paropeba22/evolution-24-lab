'use strict';

// Classification limits redaction scope; it is never destination authority.
function isManagedCta(instanceName, message) {
  const content = message?.viewOnceMessage?.message || message?.viewOnceMessageV2?.message ||
    message?.ephemeralMessage?.message || message;
  return typeof instanceName === 'string' && instanceName.startsWith('nexi-wa-') &&
    content?.interactiveMessage?.nativeFlowMessage?.buttons?.some(
      (button) => button.name === 'cta_copy' || button.name === 'cta_url',
    ) === true;
}

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
}

function failureMetadata(instanceId, messageId, stage, error) {
  // Never read message, stack, toString, request, body or Prisma arguments.
  const category = ['P2002', 'P2003', 'P2025'].includes(error?.code) ? 'persistence' :
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error?.code) ? 'transport' : 'unknown';
  return { code: 'nexi_financial_transport_failed', operation: 'sendButtons',
    instanceId: safeId(instanceId), deliveryId: safeId(messageId),
    stage: ['lookup', 'dispatch', 'persistence', 'webhook', 'response'].includes(stage) ? stage : 'unknown',
    category, status: 400 };
}

module.exports = { isManagedCta, failureMetadata };
