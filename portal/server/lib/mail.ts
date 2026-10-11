import nodemailer from 'nodemailer'
import { getConfig } from './config'

export async function sendMail(to: string, subject: string, text: string) {
  const c = getConfig()
  const transport = nodemailer.createTransport({
    host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_SECURE === 'true',
    auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD } : undefined,
    requireTLS: c.NODE_ENV === 'production' && c.SMTP_SECURE !== 'true',
  })
  await transport.sendMail({ from: c.MAIL_FROM, to, subject, text })
}
