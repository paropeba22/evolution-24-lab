'use strict';

const {createHash,randomUUID} = require('node:crypto');
const attendance = require('./nexi-attendance.cjs');
const authority = require('./nexi-attendance-authority.cjs');
function fail(code) { throw Object.assign(new Error(code), {code}); }

async function media(source, row, fetchImpl = fetch) {
  const blob = row.intent.payload.blob;
  if (!blob || !Number.isSafeInteger(blob.byte_size) || blob.byte_size < 0) fail('nexi_attendance_media_invalid');
  const destination = await attendance.boundary(source);
  if (!destination?.enabled) fail('nexi_attendance_media_unavailable');
  const grant = row.releasedAuthority.grant, release = row.releasedAuthority.release;
  const data = {...attendance.common(row.authority), inbox_id:row.authority.inbox_id, execution_id:row.executionId, attempt_id:row.attemptId,
    preparation_id:row.id,reservation_id:row.reservationId,external_id:row.externalId,grant_id:grant.grant_id,release_id:release.release_id};
  const body = {event:'attendance.media.request',instance:source.instance.name,data};
  const transport = require('./nexi-transport.cjs');
  const prepared = transport.prepareEvent(destination.headers,body,source.instance.name,source.instanceId);
  prepared.headers['X-Nexi-Event-Id'] = randomUUID();
  const response = await fetchImpl(destination.url,{method:'POST',redirect:'error',
    headers:transport.freshEventHeaders(prepared.headers,prepared.body),body:attendance.canonicalBytes(prepared.body),signal:AbortSignal.timeout(60000)});
  if (!response.ok || !response.body) fail('nexi_attendance_media_unavailable');
  const chunks = [], checksum = createHash('md5');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > blob.byte_size) fail('nexi_attendance_media_integrity');
    checksum.update(chunk); chunks.push(Buffer.from(chunk));
  }
  if (size !== blob.byte_size || checksum.digest('base64') !== blob.checksum) fail('nexi_attendance_media_integrity');
  return Buffer.concat(chunks,size);
}

async function content(source,row,fetchImpl) {
  const payload = row.intent.payload;
  if (payload.kind === 'text' && typeof payload.body === 'string') return {text:payload.body};
  if (payload.kind !== 'attachment' || !['image','file','audio','video'].includes(payload.file_type)) fail('nexi_attendance_message_unsupported');
  const bytes = await media(source,row,fetchImpl);
  const key = payload.file_type === 'file' ? 'document' : payload.file_type;
  return {[key]:bytes,mimetype:payload.blob.content_type,fileName:payload.blob.filename};
}

async function dispatch(source, material, fetchImpl = fetch) {
  if (attendance.cutoverHeld() && !material?.grant?.isolated_operation) fail('nexi_attendance_cutover_held');
  const db = source.prismaRepository.nexiAttendancePreparation;
  let row = await db.findUnique({where:{id:material.grant.preparation_id}});
  if (attendance.cutoverHeld() && !row?.authority?.isolated_operation) fail('nexi_attendance_cutover_held');
  authority.binding(source,row,material);
  if (!authority.physicalDispatchEnabled(source,row)) fail('nexi_attendance_dispatch_unreleased');
  if (row.dispatchStartedAt) return authority.result(row,material);
  if (row.authority.isolated_operation) require('./nexi-attendance-isolated.cjs').grant(source,row,material);
  const expired = await expiryReadback(source,material);
  if (expired) return expired;
  // Resolve immutable bytes before entering the irreversible lexical boundary.
  // No generic Evolution route is used and no new external ID is generated.
  const message = await content(source,row,fetchImpl);
  const quote = row.intent.payload.reply_to;
  if (quote && (typeof quote.id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(quote.id) ||
      typeof quote.from_me !== 'boolean' || typeof quote.body !== 'string')) fail('nexi_attendance_reply_invalid');
  const quoted = quote ? {key:{id:quote.id,remoteJid:row.recipient,fromMe:quote.from_me},message:{conversation:quote.body}} : undefined;
  let transportIdentity = null;
  try {
    await attendance.releasedGrantCapability(source,row.id,material.consumption_id,async () => {
      const returned = await source.service.client.sendMessage(row.recipient,message,{messageId:row.externalId,...(quoted?{quoted}:{})});
      if (returned?.key?.id !== row.externalId || returned?.key?.remoteJid !== row.recipient) fail('nexi_attendance_transport_identity_conflict');
      transportIdentity = {message_id:returned.key.id,remote_jid:returned.key.remoteJid};
    });
    row = await db.findUnique({where:{id:row.id}});
    if (!row.dispatchStartedAt) fail('nexi_attendance_dispatch_boundary_missing');
    await authority.transportReturned(source,row.id,material.consumption_id,true,transportIdentity);
  } catch (error) {
    row = await db.findUnique({where:{id:row.id}});
    if (!row.dispatchStartedAt) throw error;
    await authority.transportReturned(source,row.id,material.consumption_id,false,null);
  }
  row = await db.findUnique({where:{id:row.id}});
  // HTTP/method completion never manufactures SERVER_ACK, delivered or read.
  return authority.result(row,material);
}

async function expiryReadback(source,material) {
  return source.prismaRepository.$transaction(async tx => {
    await authority.storageGuard(tx);
    // Serialize with a CAS that began before expiry. The certified database
    // trigger rejects any later dispatch transition using its own clock.
    const mysql = process.env.DATABASE_PROVIDER === 'mysql';
    await tx.$queryRawUnsafe(mysql ? 'SELECT id FROM NexiAttendancePreparation WHERE id=? FOR UPDATE' :
      'SELECT id FROM "NexiAttendancePreparation" WHERE id=$1 FOR UPDATE',material.grant.preparation_id);
    const row = await tx.nexiAttendancePreparation.findUnique({where:{id:material.grant.preparation_id}});
    authority.binding(source,row,material);
    if (row.dispatchStartedAt) return authority.result(row,material);
    const now = await authority.clock(tx);
    if (now < material.release.deadline && now < material.grant.expires_at) return null;
    return {...authority.result(row,material),state:'release_expired_before_dispatch'};
  },{maxWait:3000,timeout:10000});
}

module.exports = {dispatch,content,media,expiryReadback};
