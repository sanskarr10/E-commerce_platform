import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  api,
  customerToken,
  adminToken,
  hs256Token,
  keys,
  startServer,
  token,
  unsignedToken,
  validClaims,
  widget,
} from './helpers.js';

// Admin-only endpoint used to probe the token verifier.
const create = (ctx, bearer) => api(ctx.baseUrl, 'POST', '/api/products', { token: bearer, body: widget() });

describe('JWT verification on admin routes', () => {
  let ctx;
  before(async () => {
    ctx = await startServer();
  });
  after(() => ctx.close());

  it('accepts a valid admin token', async () => {
    assert.equal((await create(ctx, adminToken())).status, 201);
  });

  it('rejects a missing token with a Bearer challenge', async () => {
    const response = await create(ctx, undefined);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  });

  it('rejects a customer with 403, not 401', async () => {
    assert.equal((await create(ctx, customerToken())).status, 403);
  });

  it('rejects non-Bearer schemes and garbage', async () => {
    const basic = await api(ctx.baseUrl, 'POST', '/api/products', { body: widget(), headers: { authorization: 'Basic abc' } });
    assert.equal(basic.status, 401);
    assert.equal((await create(ctx, 'not.a.jwt')).status, 401);
    assert.equal((await create(ctx, 'garbage')).status, 401);
  });

  it('rejects an expired token', async () => {
    const expired = token({}, { signOptions: { expiresIn: -60 } });
    assert.equal((await create(ctx, expired)).status, 401);
  });

  it('rejects a token signed by a different key', async () => {
    const other = (await import('node:crypto')).generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    assert.equal((await create(ctx, token({}, { key: other.privateKey }))).status, 401);
  });

  it('rejects the HS256 key-confusion attack (public key used as the HMAC secret)', async () => {
    const forged = hs256Token(keys.publicKey, validClaims());
    assert.equal((await create(ctx, forged)).status, 401);
  });

  it('rejects an unsigned (alg=none) token', async () => {
    assert.equal((await create(ctx, unsignedToken(validClaims()))).status, 401);
  });

  it('rejects wrong audience and wrong issuer', async () => {
    assert.equal((await create(ctx, token({}, { signOptions: { expiresIn: '5m', audience: 'some-other-app' } }))).status, 401);
    assert.equal((await create(ctx, token({}, { signOptions: { expiresIn: '5m', issuer: 'evil-issuer' } }))).status, 401);
  });

  it('rejects a validly signed token that never expires', async () => {
    assert.equal((await create(ctx, token({}, { signOptions: {} }))).status, 401);
  });

  it('rejects a validly signed token without a subject', async () => {
    const noSub = token({ sub: undefined });
    assert.equal((await create(ctx, noSub)).status, 401);
  });

  it('does not require a token for public reads', async () => {
    assert.equal((await api(ctx.baseUrl, 'GET', '/api/products')).status, 200);
    assert.equal((await api(ctx.baseUrl, 'GET', '/api/products/categories')).status, 200);
  });

  it('checks authentication before validating the body (no validation oracle for anonymous users)', async () => {
    const response = await api(ctx.baseUrl, 'POST', '/api/products', { body: {} });
    assert.equal(response.status, 401);
  });
});
