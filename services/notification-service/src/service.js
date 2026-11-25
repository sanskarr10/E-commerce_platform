import { consumedSchemas } from './events/schemas.js';
import { PermanentError } from './events/consumer.js';
import { PermanentMailError } from './mailer.js';
import { render } from './templates.js';

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Event -> stored notification -> email.
 * Idempotency comes from the database, not from remembering event ids: (order, type) is unique, and the
 * email is claimed with a lease, so a redelivered event neither duplicates the notification nor re-sends
 * an email that already went out.
 *
 * Email is at-least-once: if the process dies after the SMTP server accepted the message but before we
 * recorded it, the lease expires and the email is sent again. That is the usual trade-off with SMTP.
 */
export class NotificationService {
  constructor({ repo, mailer, config, logger, metrics }) {
    this.repo = repo;
    this.mailer = mailer;
    this.leaseSeconds = config.emailLeaseSeconds;
    this.logger = logger;
    this.metrics = metrics;
  }

  /** Builds one handler per event type, in the shape processDelivery expects. */
  handlers() {
    return Object.fromEntries(Object.keys(consumedSchemas).map((type) => [type, (envelope) => this.handle(envelope)]));
  }

  async handle(envelope) {
    const schema = consumedSchemas[envelope.type];
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) throw new PermanentError(`invalid ${envelope.type} payload: ${parsed.error.message}`);
    const data = parsed.data;

    const email = data.user_email && EMAIL_SHAPE.test(data.user_email) ? data.user_email : null;
    const { title, body } = render(envelope.type, data);
    const { notification, created } = await this.repo.createNotification({
      userId: data.user_id,
      userEmail: email,
      type: envelope.type,
      orderId: data.order_id,
      title,
      body,
    });
    if (created) this.metrics?.notificationCreated(envelope.type);

    const outcome = await this.#deliverEmail(notification);
    return created ? outcome : `duplicate_${outcome}`;
  }

  async #deliverEmail(notification) {
    if (notification.email_status === 'sent' || notification.email_status === 'failed' || notification.email_status === 'skipped') {
      return 'already_done';
    }
    if (!notification.user_email || !this.mailer.enabled) {
      // Nothing to send to (no address, or email switched off): the in-app notification is the delivery.
      await this.repo.setEmailStatus(notification.id, 'skipped');
      this.metrics?.emailResult('skipped');
      return 'in_app_only';
    }
    const claimed = await this.repo.claimEmail(notification.id, this.leaseSeconds);
    // Another worker holds a live claim. If it finishes, our retry finds the row done; if it died, the
    // lease expires and a later retry takes over. Either way the event must not be acknowledged yet.
    if (!claimed) throw new Error('email send in progress elsewhere');
    try {
      await this.mailer.send({ to: notification.user_email, subject: notification.title, text: notification.body });
    } catch (err) {
      if (err instanceof PermanentMailError) {
        await this.repo.setEmailStatus(notification.id, 'failed', err.message);
        this.metrics?.emailResult('failed');
        this.logger.warn('email rejected, keeping the in-app notification only', { error: err.message });
        return 'email_failed';
      }
      await this.repo.setEmailStatus(notification.id, 'pending', err.message);
      this.metrics?.emailResult('retry');
      throw err; // transient: the consumer retries after a delay
    }
    await this.repo.setEmailStatus(notification.id, 'sent');
    this.metrics?.emailResult('sent');
    return 'emailed';
  }
}
