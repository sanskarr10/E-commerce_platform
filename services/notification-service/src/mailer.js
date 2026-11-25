import nodemailer from 'nodemailer';
import { PermanentError } from './events/consumer.js';

/** Raised for failures a retry cannot fix (an address the server refuses). */
export class PermanentMailError extends PermanentError {}

/**
 * Email channel. With no SMTP_URL it is disabled and the service only stores in-app notifications.
 * A 5xx reply from the SMTP server is permanent (bad address); anything else (4xx, network) is transient.
 */
export function createMailer({ smtpUrl, from, transport }) {
  const enabled = Boolean(transport || smtpUrl);
  const tx = transport ?? (smtpUrl ? nodemailer.createTransport(smtpUrl, { connectionTimeout: 5000, socketTimeout: 10000 }) : null);
  return {
    enabled,
    async send({ to, subject, text }) {
      if (!tx) return { skipped: true };
      try {
        await tx.sendMail({ from, to, subject, text });
        return { sent: true };
      } catch (err) {
        if (typeof err.responseCode === 'number' && err.responseCode >= 500) {
          throw new PermanentMailError(`SMTP ${err.responseCode}: ${err.message}`);
        }
        throw err;
      }
    },
    close: () => tx?.close?.(),
  };
}
