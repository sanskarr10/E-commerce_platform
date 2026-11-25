import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { consumedSchemas, envelopeSchema } from '../src/events/schemas.js';
import { CONSUMED_TYPES } from '../src/events/envelope.js';
import { buildService } from './helpers.js';

const DIR = path.join(import.meta.dirname, '..', '..', '..', 'docs', 'events', 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), 'utf8'));

describe('event contract (shared fixtures)', () => {
  it('consumes exactly the events it declares', () => {
    assert.deepEqual(Object.keys(consumedSchemas).sort(), [...CONSUMED_TYPES].sort());
    assert.equal(readdirSync(DIR).filter((f) => f.endsWith('.json')).length, 10);
  });

  for (const type of CONSUMED_TYPES) {
    it(`parses the ${type} fixture and turns it into a notification`, async () => {
      const raw = fixture(type);
      envelopeSchema.parse(raw);
      consumedSchemas[type].parse(raw.data);
      const { service, repo, transport } = buildService();
      await service.handle(raw);
      assert.equal(repo.rows.length, 1);
      assert.equal(repo.rows[0].type, type);
      assert.equal(transport.sent.length, 1);
      assert.equal(transport.sent[0].to, 'asha@example.com');
    });
  }

  it('tolerates unknown fields on envelope and data', () => {
    const raw = fixture('order.shipped');
    raw.extra = 1;
    raw.data.carrier = 'later';
    envelopeSchema.parse(raw);
    consumedSchemas['order.shipped'].parse(raw.data);
  });

  it('rejects an order.cancelled without user_id: it could not tell anyone', () => {
    const raw = fixture('order.cancelled');
    delete raw.data.user_id;
    assert.throws(() => consumedSchemas['order.cancelled'].parse(raw.data));
  });
});
