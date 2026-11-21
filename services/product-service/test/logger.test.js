import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createLogger, requestContext } from '../src/logger.js';

describe('logger', () => {
  afterEach(() => mock.restoreAll());

  function capture() {
    const lines = [];
    mock.method(process.stdout, 'write', (chunk) => {
      lines.push(String(chunk));
      return true;
    });
    return lines;
  }

  it('writes one JSON object per line with the standard fields', () => {
    const lines = capture();
    createLogger().info('hello', { extra: 1 });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith('\n'));
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.level, 'INFO');
    assert.equal(entry.logger, 'product-service');
    assert.equal(entry.message, 'hello');
    assert.equal(entry.extra, 1);
    assert.equal(entry.request_id, '-');
    assert.ok(!Number.isNaN(Date.parse(entry.ts)));
  });

  it('attaches the current request id from the async context', () => {
    const lines = capture();
    requestContext.run({ requestId: 'req-42' }, () => createLogger().warn('inside'));
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.level, 'WARNING');
    assert.equal(entry.request_id, 'req-42');
  });

  it('marks errors and can be silenced', () => {
    const lines = capture();
    createLogger().error('boom');
    assert.equal(JSON.parse(lines[0]).level, 'ERROR');
    const silent = createLogger({ silent: true });
    silent.info('x');
    silent.warn('x');
    silent.error('x');
    assert.equal(lines.length, 1);
  });
});
