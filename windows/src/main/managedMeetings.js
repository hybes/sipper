// Ephemeral meeting responses. Neither these grants nor media credentials are saved.
import { z } from 'zod';
import { uuid } from './managedContracts.js';
import { messageScope, messageUser } from './managedMessages.js';

const time = z.iso.datetime({ offset: true });
const name = z.string().min(1).max(160).refine(value => !/[\x00-\x1f\x7f-\x9f]/.test(value));
export const meeting = z.object({ id: uuid, conversationId: uuid, createdBy: messageUser.nullable(),
  createdAt: time, expiresAt: time, endedAt: time.nullable(), controlConfirmedAt: time.nullable() }).strict()
  .refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt)
    && (!value.controlConfirmedAt || Boolean(value.endedAt)));
export const currentMeeting = z.object({ ...messageScope, available: z.boolean(), meeting: meeting.nullable() }).strict();
export const meetingResult = z.object({ ...messageScope, meeting }).strict();
export const meetingDetails = z.object({ ...messageScope, available: z.boolean(), canJoin: z.boolean(),
  title: name, hostName: name.nullable(), meeting, sessions: z.array(z.object({ id: uuid, userId: messageUser,
    name: name.nullable(), deviceId: uuid.nullable(), revokedAt: time.nullable(), admittedAt: time.nullable(),
    controlConfirmedAt: time.nullable() }).strict()).max(100) }).strict()
  .refine(value => new Set(value.sessions.map(s => s.id)).size === value.sessions.length
    && (!value.canJoin || (value.available && !value.meeting.endedAt)));
export const meetingJoin = z.object({ schemaVersion: z.literal(1), organisationId: uuid, meetingId: uuid,
  sessionId: uuid, identity: z.string().max(64), url: z.string().max(512),
  token: z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), expiresAt: time }).strict();
export const meetingLeave = z.object({ ...messageScope, meetingId: uuid, sessionId: uuid, leaveRequested: z.literal(true) }).strict();
export const meetingRemoval = z.object({ ...messageScope, meetingId: uuid, targetUserId: messageUser, removalRequested: z.literal(true) }).strict();

export function meetingOrigin(value, allowLocalDevelopment = false) {
  const url = new URL(value);
  const local = allowLocalDevelopment && url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'wss:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('invalid_meeting_origin');
  return url.origin;
}
export function validateMeetingGrant(value, organisationId, meetingId, sessionId, now, allowLocalDevelopment) {
  meetingOrigin(value.url, allowLocalDevelopment);
  const claims = JSON.parse(Buffer.from(value.token.split('.')[1], 'base64url').toString('utf8'));
  if (value.organisationId !== organisationId || value.meetingId !== meetingId || value.sessionId !== sessionId
    || value.identity !== `sipper:${sessionId}` || claims.sub !== value.identity
    || claims.video?.room !== `sipper-${meetingId}` || claims.video?.roomJoin !== true
    || claims.video.canPublishData !== false || claims.video.canSubscribe !== true || claims.video.canPublish !== true
    || claims.video.canUpdateOwnMetadata !== false || !Array.isArray(claims.video.canPublishSources)
    || claims.video.canPublishSources.length !== 4 || new Set(claims.video.canPublishSources).size !== 4
    || claims.video.canPublishSources.some(source => !['microphone', 'camera', 'screen_share', 'screen_share_audio'].includes(source))
    || claims.video.roomAdmin || claims.video.roomCreate
    || claims.video.roomList || claims.video.roomRecord || claims.video.ingressAdmin || claims.video.destinationRoom
    || claims.sip || claims.inference || claims.observability || !Number.isInteger(claims.exp)
    || claims.exp * 1000 <= now || claims.exp * 1000 > now + 120_000
    || Math.abs(claims.exp * 1000 - Date.parse(value.expiresAt)) > 1500) throw Error('invalid_meeting_grant');
  return value;
}

export function meetingCSP(origin = null) {
  // Only the exact verified signalling origin and its HTTP counterpart can connect.
  const connect = origin ? `${origin} ${origin.replace(/^ws/, 'http')}` : "'none'";
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src ${connect}; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
}
