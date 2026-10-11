import { isIP } from 'node:net'
import { rows } from './db'
import type { Principal } from './access'

function normaliseIp(value: string) {
  const ip = value.trim().replace(/^::ffff:(?=\d+\.)/i, '')
  return isIP(ip) ? ip : null
}

// Forwarding headers are only usable when the immediate peer is a configured proxy.
// Walk from the socket backwards so client-supplied prefixes cannot forge the address.
export function requestIp(peer: string | undefined, forwarded: string | null, trusted: string): string | null {
  let ip = normaliseIp(peer ?? '')
  const proxies = new Set(trusted.split(',').map(normaliseIp).filter(Boolean))
  if (!ip || !proxies.has(ip) || !forwarded) return ip
  for (const hop of forwarded.split(',').reverse()) {
    if (!proxies.has(ip)) break
    const next = normaliseIp(hop)
    if (!next) return null
    ip = next
  }
  return ip
}

export type DeviceRequestAction = 'enrolment' | 'configuration' | 'report' | 'sign_out' | 'push_token' | 'call' | 'directory' | 'messages' | 'meetings'
export async function recordDeviceRequest(actor: Principal, deviceId: string, action: DeviceRequestAction, ip: string | null) {
  await rows(`UPDATE devices SET last_request_at=now(),last_request_ip=$3::inet,last_request_action=$4,
    last_login_at=GREATEST(last_login_at,$5::timestamptz)
    WHERE id=$1 AND user_id=$2 RETURNING id`, [deviceId, actor.userId, ip, action, actor.sessionCreatedAt ?? null])
}

export async function recordConfigurationDelivery(actor: Principal, deviceId: string) {
  await rows('UPDATE devices SET last_configuration_at=now() WHERE id=$1 AND user_id=$2 RETURNING id', [deviceId, actor.userId])
}
