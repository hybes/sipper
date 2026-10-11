import { z } from 'zod'
import type { MessageScope } from './messages'

export const meetingInput = z.object({ id:z.uuid().transform(id=>id.toLowerCase()) }).strict()
export const meetingJoinInput = z.object({ id:z.uuid().transform(id=>id.toLowerCase()) }).strict()
export interface Meeting {
  id:string; conversationId:string; createdBy:string|null; createdAt:string; expiresAt:string
  endedAt:string|null; controlConfirmedAt:string|null
}
export interface MeetingJoin {
  schemaVersion:1; organisationId:string; meetingId:string; sessionId:string; identity:string
  url:string; token:string; expiresAt:string
}
export interface MeetingDetails extends MessageScope {
  available:boolean; canJoin:boolean; title:string; hostName:string|null; meeting:Meeting
  sessions:Array<{id:string;userId:string;name:string|null;deviceId:string|null;revokedAt:string|null;admittedAt:string|null;controlConfirmedAt:string|null}>
}
