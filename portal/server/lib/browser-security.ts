import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

export function authenticEdge(supplied: string | undefined, expected: string) {
  if (!expected || !supplied || supplied.length > 512) return false
  // Fixed-length comparison also avoids leaking the secret's length.
  return timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(expected).digest())
}

export function edgeClientIP(value: string | undefined): string | null {
  return value && isIP(value) ? value : null
}

export const browserHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Robots-Tag': 'noindex',
}

export function portalPermissions(path:string) {
  return path==='/portal' || path.startsWith('/portal/') ? 'camera=(self), microphone=(self), geolocation=(), payment=()' : browserHeaders['Permissions-Policy']
}
export function contentSecurityPolicy(trustedHead: string[] = [], meetingUrl='') {
  const connections=["'self'"]
  if(meetingUrl) {
    const url=new URL(meetingUrl)
    if(!['ws:','wss:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw Error('Invalid meeting signalling origin')
    connections.push(url.origin)
    url.protocol=url.protocol==='wss:' ? 'https:' : 'http:';connections.push(url.origin)
  }
  const hashes = new Set<string>()
  // Nuxt's generated head/payload scripts only. Never hash the rendered page body
  // or user HTML. The portal is a non-streamed SPA shell (ssr:false route rules).
  for (const fragment of trustedHead) {
    for (const match of fragment.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/\bsrc\s*=/i.test(match[1]!) || !match[2]) continue
      hashes.add(`'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`)
    }
  }
  return [
    "default-src 'none'", `script-src 'self' ${[...hashes].join(' ')}`.trim(),
    "script-src-attr 'none'", "style-src 'self' 'unsafe-inline'", // Nuxt UI positions popovers with inline styles.
    "img-src 'self' data: blob:", "font-src 'self'", `connect-src ${connections.join(' ')}`, "media-src 'self' blob:",
    "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; ')
}
