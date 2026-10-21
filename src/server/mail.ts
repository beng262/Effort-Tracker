import nodemailer from 'nodemailer';
import { config } from './config.js';

export interface Mailer {
  send(to: string[], subject: string, text: string, attachments?: { filename: string; content: Buffer }[]): Promise<void>;
}

export function createMailer(): Mailer {
  if (!config.SMTP_URL) {
    return { async send(to, subject) { console.log(`[mail not configured] to=${to.join(',')} subject=${subject}`); } };
  }
  const t = nodemailer.createTransport(config.SMTP_URL);
  return { async send(to, subject, text, attachments) { await t.sendMail({ from: config.MAIL_FROM, to, subject, text, attachments }); } };
}
