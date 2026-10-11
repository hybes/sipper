// Short-lived message responses. These schemas never enter the saved managed session.
import { z } from 'zod';
import { uuid } from './managedContracts.js';

const text = z.string().min(1).refine(value => !/[\x00-\x1f\x7f-\x9f]/.test(value));
export const messageUser = text.pipe(z.string().max(128));
const name = text.pipe(z.string().max(160));
export const messageSequence = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/)
  .pipe(z.string().refine(value => BigInt(value) <= 9223372036854775807n));
export const positiveSequence = messageSequence.refine(value => value !== '0');
export const conversationCursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const messageSearch = z.string().trim().max(160).refine(value => !/[\x00-\x1f\x7f-\x9f]/.test(value));
export const newConversation = z.object({ id: uuid, userIds: z.array(messageUser).min(1).max(19), title: messageSearch.default('') }).strict()
  .refine(value => new Set(value.userIds).size === value.userIds.length && (value.userIds.length === 1 || Boolean(value.title)));
export const newMessage = z.object({ id: uuid, text: z.string().min(1).max(4096)
  .refine(value => Boolean(value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) }).strict();
export const groupInput = z.object({ revision: positiveSequence, title: messageSearch.refine(Boolean),
  userIds: z.array(messageUser).min(1).max(20), ownerId: messageUser }).strict()
  .refine(value => new Set(value.userIds).size === value.userIds.length && value.userIds.includes(value.ownerId));
export const messageScope = {
  schemaVersion: z.literal(1), organisation: z.object({ id: uuid, name }), deviceId: uuid,
  userId: messageUser, expiresAt: z.iso.datetime({ offset: true }), retentionDays: z.number().int().min(1).max(3650),
};
const scope = messageScope;
export const messageAlerts = z.object({ ...scope, alerts: z.array(z.object({ conversationId: uuid, sequence: positiveSequence,
  expiresAt: z.iso.datetime({ offset: true }), }).strict()).max(100), nextCursor: positiveSequence.nullable() }).strict()
  .refine(value => new Set(value.alerts.map(a => a.conversationId)).size === value.alerts.length
    && value.alerts.every((a,i,rows) => i === 0 || BigInt(a.sequence) > BigInt(rows[i-1].sequence))
    && (value.nextCursor === null || (value.alerts.length === 100 && value.nextCursor === value.alerts.at(-1).sequence)));
const person = z.object({ id: messageUser, name });
const conversation = z.object({
  id: uuid, kind: z.enum(['direct', 'group']), title: name,
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
  participants: z.array(person.extend({ lastReadSequence: messageSequence, joinedSequence: messageSequence.optional() })).min(1).max(20),
  unread: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), lastSequence: messageSequence,
  revision: positiveSequence.optional(), ownerId: messageUser.nullable().optional(),
}).refine(value => Date.parse(value.updatedAt) >= Date.parse(value.createdAt)
  && (value.kind !== 'direct' || value.participants.length <= 2)
  && new Set(value.participants.map(p => p.id)).size === value.participants.length
  && value.participants.every(p => p.joinedSequence == null || (BigInt(p.joinedSequence) <= BigInt(value.lastSequence) && BigInt(p.lastReadSequence) >= BigInt(p.joinedSequence)))
  && (value.kind === 'direct' ? value.ownerId == null : value.revision == null ? value.ownerId == null : value.participants.some(p => p.id === value.ownerId)));
const message = z.object({ id: uuid, sequence: positiveSequence, senderId: messageUser.nullable(),
  senderName: name, text: newMessage.shape.text, createdAt: z.iso.datetime({ offset: true }) });
export const messagePeople = z.object({ ...scope, people: z.array(person).max(100), nextCursor: messageUser.nullable() })
  .refine(value => new Set(value.people.map(p => p.id)).size === value.people.length
    && !value.people.some(p => p.id === value.userId)
    && (value.nextCursor === null || (value.people.length === 100 && value.nextCursor === value.people.at(-1).id)));
export const conversationPage = z.object({ ...scope, conversations: z.array(conversation).max(100), nextCursor: conversationCursor.nullable() })
  .refine(value => new Set(value.conversations.map(c => c.id)).size === value.conversations.length
    && value.conversations.every(c => c.participants.some(p => p.id === value.userId))
    && (value.nextCursor === null || value.conversations.length === 100));
export const messagePage = z.object({ ...scope, conversation, messages: z.array(message).max(100), nextCursor: positiveSequence.nullable() })
  .refine(value => new Set(value.messages.map(m => m.id)).size === value.messages.length
    && value.conversation.participants.some(p => p.id === value.userId)
    && value.messages.every(m => BigInt(m.sequence) > BigInt(value.conversation.participants.find(p => p.id === value.userId)?.joinedSequence ?? '0'))
    && value.messages.every((m, index, rows) => index === 0 || BigInt(m.sequence) > BigInt(rows[index - 1].sequence)));
export const conversationResult = z.object({ ...scope, conversation })
  .refine(value => value.conversation.participants.some(p => p.id === value.userId));
export const messageResult = z.object({ ...scope, message });
export const messageReadResult = z.object({ ...scope, sequence: messageSequence });
export const messageLeaveResult = z.object({ ...scope, conversationId: uuid, left: z.literal(true) });
