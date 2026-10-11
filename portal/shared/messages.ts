import { z } from 'zod'

const identity = z.string().min(1).max(128)
const id = z.uuid().transform(value => value.toLowerCase())
export const messageSequence = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/).pipe(z.string().refine(value => BigInt(value) <= 9223372036854775807n))
const title = z.string().trim().max(160).refine(value => !/[\x00-\x1f\x7f-\x9f]/.test(value), 'Use a title without control characters')
export const conversationInput = z.object({ id, userIds: z.array(identity).min(1).max(19), title: title.default('') }).strict()
  .refine(value => new Set(value.userIds).size === value.userIds.length, 'Choose each person once')
  .refine(value => value.userIds.length === 1 || Boolean(value.title), 'Give the group a name')
export const messageInput = z.object({ id, text: z.string().min(1).max(4096)
  .refine(value => Boolean(value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value), 'Enter a text message without control characters') }).strict()
export const groupInput = z.object({ revision: messageSequence.refine(value => value !== '0'), title: title.min(1),
  userIds: z.array(identity).min(1).max(20), ownerId: identity }).strict()
  .refine(value => new Set(value.userIds).size === value.userIds.length && value.userIds.includes(value.ownerId), 'Choose each person once and an owner from the group')
export interface MessagePerson { id: string; name: string }
export interface Conversation {
  id: string; kind: 'direct' | 'group'; title: string; createdAt: string; updatedAt: string
  participants: Array<MessagePerson & { lastReadSequence: string; joinedSequence: string }>
  unread: number; lastSequence: string; revision: string; ownerId: string | null
}
export interface TextMessage { id: string; sequence: string; senderId: string | null; senderName: string; text: string; createdAt: string }
export interface MessageScope {
  schemaVersion: 1; organisation: { id: string; name: string }; userId: string; deviceId: string | null; expiresAt: string; retentionDays: number
}
export interface ConversationPage extends MessageScope { conversations: Conversation[]; nextCursor: string | null }
export interface MessagePage extends MessageScope { conversation: Conversation; messages: TextMessage[]; nextCursor: string | null }
export interface MessagePeople extends MessageScope { people: MessagePerson[]; nextCursor: string | null }
