import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermanentError } from '../src/events/consumer.js';
import { createMailer } from '../src/mailer.js';
import { FakeRepo, FakeTransport, ORDER, USER, buildService, confirmed, envelope, smtpError } from './helpers.js';

describe('NotificationService', () => {
  it('stores a notification and emails the customer', async () => {
    const { service, repo, transport } = buildService();
    const outcome = await service.handle(envelope('order.confirmed', confirmed()));
    assert.equal(outcome, 'emailed');
    assert.equal(repo.rows.length, 1);
    assert.equal(repo.rows[0].email_status, 'sent');
    assert.equal(repo.rows[0].title, 'Payment received');
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].to, 'asha@example.com');
    assert.match(transport.sent[0].text, /₹2,499/);
  });

  it('is idempotent: the same event twice sends one email and keeps one notification', async () => {
    const { service, repo, transport } = buildService();
    const event = envelope('order.confirmed', confirmed());
    await service.handle(event);
    assert.equal(await service.handle(event), 'duplicate_already_done');
    assert.equal(repo.rows.length, 1);
    assert.equal(transport.sent.length, 1);
  });

  it('treats a re-emitted event with a NEW event id as a duplicate too (unique per order and type)', async () => {
    const { service, repo, transport } = buildService();
    await service.handle(envelope('order.cancelled', { order_id: ORDER, user_id: USER, user_email: 'a@b.co', reason: 'payment_failed' }));
    await service.handle(envelope('order.cancelled', { order_id: ORDER, user_id: USER, user_email: 'a@b.co', reason: 'payment_failed' }));
    assert.equal(repo.rows.length, 1);
    assert.equal(transport.sent.length, 1);
  });

  it('keeps one notification per event type for the same order', async () => {
    const { service, repo } = buildService();
    await service.handle(envelope('order.confirmed', confirmed()));
    await service.handle(envelope('order.shipped', { order_id: ORDER, user_id: USER, user_email: 'a@b.co' }));
    await service.handle(envelope('order.delivered', { order_id: ORDER, user_id: USER, user_email: 'a@b.co' }));
    assert.deepEqual(repo.rows.map((r) => r.type), ['order.confirmed', 'order.shipped', 'order.delivered']);
  });

  it('still stores an in-app notification when there is no email address', async () => {
    const { service, repo, transport } = buildService();
    assert.equal(await service.handle(envelope('order.confirmed', confirmed({ user_email: null }))), 'in_app_only');
    assert.equal(repo.rows[0].email_status, 'skipped');
    assert.equal(transport.sent.length, 0);
  });

  it('ignores an address that is not an address', async () => {
    const { service, repo, transport } = buildService();
    await service.handle(envelope('order.confirmed', confirmed({ user_email: 'not an email' })));
    assert.equal(repo.rows[0].user_email, null);
    assert.equal(transport.sent.length, 0);
  });

  it('works with email switched off (no SMTP configured)', async () => {
    const { service, repo } = buildService({ mailer: createMailer({ smtpUrl: '', from: 'x' }) });
    assert.equal(await service.handle(envelope('order.confirmed', confirmed())), 'in_app_only');
    assert.equal(repo.rows[0].email_status, 'skipped');
  });

  it('retries a transient SMTP failure and sends exactly once when it recovers', async () => {
    const { service, repo, transport } = buildService();
    transport.failures.push(smtpError(421, 'try later'));
    const event = envelope('order.confirmed', confirmed());
    await assert.rejects(() => service.handle(event), /try later/);
    assert.equal(repo.rows[0].email_status, 'pending');
    assert.match(repo.rows[0].email_error, /try later/);
    assert.equal(await service.handle(event), 'duplicate_emailed');
    assert.equal(repo.rows[0].email_status, 'sent');
    assert.equal(transport.sent.length, 1);
  });

  it('gives up on an address the server refuses but keeps the in-app notification', async () => {
    const { service, repo, transport } = buildService();
    transport.failures.push(smtpError(550, 'no such user'));
    assert.equal(await service.handle(envelope('order.confirmed', confirmed())), 'email_failed');
    assert.equal(repo.rows[0].email_status, 'failed');
    assert.match(repo.rows[0].email_error, /550/);
  });

  it('does not send while another worker holds a live claim, but takes over once the lease expires', async () => {
    let now = 1_000_000;
    const repo = new FakeRepo({ now: () => now });
    const { service, transport } = buildService({ repo });
    const event = envelope('order.confirmed', confirmed());
    const { notification } = await repo.createNotification({
      userId: USER, userEmail: 'asha@example.com', type: 'order.confirmed', orderId: ORDER, title: 't', body: 'b',
    });
    await repo.claimEmail(notification.id, 120); // a worker that then died
    await assert.rejects(() => service.handle(event), /in progress elsewhere/);
    assert.equal(transport.sent.length, 0);
    now += 121_000;
    assert.equal(await service.handle(event), 'duplicate_emailed');
    assert.equal(transport.sent.length, 1);
  });

  it('rejects a payload that breaks the contract, permanently', async () => {
    const { service } = buildService();
    await assert.rejects(
      () => service.handle(envelope('order.confirmed', { order_id: 'nope', user_id: USER })),
      (err) => err instanceof PermanentError,
    );
  });

  it('tolerates fields added by newer producers', async () => {
    const { service, repo } = buildService();
    await service.handle(envelope('order.shipped', { order_id: ORDER, user_id: USER, user_email: 'a@b.co', carrier: 'later' }));
    assert.equal(repo.rows.length, 1);
  });

  it('has a handler for exactly the events it consumes', () => {
    const { service } = buildService();
    assert.deepEqual(Object.keys(service.handlers()).sort(), ['order.cancelled', 'order.confirmed', 'order.delivered', 'order.shipped']);
  });

  it('counts what it does in metrics', async () => {
    const { service, metrics } = buildService();
    await service.handle(envelope('order.confirmed', confirmed()));
    const text = await metrics.render();
    assert.match(text, /notifications_created_total\{type="order.confirmed"\} 1/);
    assert.match(text, /notification_emails_total\{result="sent"\} 1/);
    assert.match(text, /notification_emails_open 0/);
  });
});

describe('mailer', () => {
  it('is disabled without SMTP_URL and a no-op', async () => {
    const mailer = createMailer({ smtpUrl: '', from: 'x' });
    assert.equal(mailer.enabled, false);
    assert.deepEqual(await mailer.send({ to: 'a@b.co', subject: 's', text: 't' }), { skipped: true });
  });
  it('passes the sender and content to the transport', async () => {
    const transport = new FakeTransport();
    await createMailer({ transport, from: 'Shop <s@x.io>' }).send({ to: 'a@b.co', subject: 'S', text: 'T' });
    assert.deepEqual(transport.sent[0], { from: 'Shop <s@x.io>', to: 'a@b.co', subject: 'S', text: 'T' });
  });
});
