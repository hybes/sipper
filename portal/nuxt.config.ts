import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-22',
  modules: ['@nuxt/ui'],
  css: ['~/assets/main.css'],
  devtools: { enabled: false },
  app: {
    head: {
      title: 'Sipper · Management',
      link: [{ rel: 'icon', type: 'image/png', href: '/assets/sipper-icon.png' }],
      meta: [{ name: 'description', content: 'Manage your Sipper customers, people and calling accounts.' }],
    },
  },
  routeRules: {
    '/portal': { ssr: false, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
    '/api/**': { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
    '/.well-known/**': { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
    '/portal/**': { ssr: false, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
    '/portal/setup': { ssr: false, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } },
    '/portal/workspace-invitation': { ssr: false, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } },
  },
  nitro: {
    preset: 'node-server',
    errorHandler: process.env.NODE_ENV === 'production' ? fileURLToPath(new URL('./server/error.ts', import.meta.url)) : undefined,
  },
  typescript: { strict: true },
})
