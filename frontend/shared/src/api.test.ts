import { ApiError, createApiClient, readDetail } from './api';
import { mockFetch } from './test-utils';

describe('readDetail', () => {
  it('uses string details as the message', () => {
    expect(readDetail(409, 'SKU already exists').message).toBe('SKU already exists');
  });
  it('maps validation issues to fields', () => {
    const err = readDetail(422, [
      { loc: ['body', 'email'], msg: 'not a valid email', type: 'x' },
      { loc: ['body', 'password'], msg: 'too short', type: 'x' },
    ]);
    expect(err.fieldErrors).toEqual({ email: 'not a valid email', password: 'too short' });
    expect(err.message).toBe('email: not a valid email');
  });
  it('falls back to friendly text', () => {
    expect(readDetail(503, null).message).toMatch(/temporarily unavailable/);
    expect(readDetail(418, null).message).toMatch(/418/);
  });
});

describe('api client', () => {
  it('sends the bearer token and JSON body', async () => {
    const m = mockFetch({ 'POST /api/x': { body: { ok: true } } });
    const api = createApiClient({ fetchImpl: m.fetch });
    api.setToken('abc');
    await api.request('POST', '/api/x', { body: { a: 1 } });
    expect(m.calls[0]!.headers.Authorization).toBe('Bearer abc');
    expect(m.calls[0]!.body).toEqual({ a: 1 });
  });

  it('drops empty query values', async () => {
    const m = mockFetch({ 'GET /api/x': { body: [] } });
    const api = createApiClient({ fetchImpl: m.fetch });
    await api.request('GET', '/api/x', { query: { q: '', page: 2, flag: false, none: undefined } });
    expect(m.calls[0]!.url).toBe('/api/x?page=2&flag=false');
  });

  it('refreshes once on 401 and retries', async () => {
    const m = mockFetch({
      'GET /api/me': [{ status: 401, body: { detail: 'expired' } }, { body: { id: 'u1' } }],
      'POST /api/users/refresh': { body: { access_token: 'new' } },
    });
    const api = createApiClient({ fetchImpl: m.fetch });
    api.setToken('old');
    await expect(api.request('GET', '/api/me')).resolves.toEqual({ id: 'u1' });
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/me', 'POST /api/users/refresh', 'GET /api/me']);
    expect(m.calls[2]!.headers.Authorization).toBe('Bearer new');
  });

  it('shares ONE refresh between concurrent 401s', async () => {
    const m = mockFetch({
      'GET /api/a': [{ status: 401 }, { body: 'a' }],
      'GET /api/b': [{ status: 401 }, { body: 'b' }],
      'POST /api/users/refresh': async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { body: { access_token: 'new' } };
      },
    });
    const api = createApiClient({ fetchImpl: m.fetch });
    await Promise.all([api.request('GET', '/api/a'), api.request('GET', '/api/b')]);
    expect(m.calls.filter((c) => c.url === '/api/users/refresh')).toHaveLength(1);
  });

  it('signals session loss when refresh fails', async () => {
    const m = mockFetch({
      'GET /api/me': { status: 401, body: { detail: 'expired' } },
      'POST /api/users/refresh': { status: 401, body: { detail: 'no' } },
    });
    const api = createApiClient({ fetchImpl: m.fetch });
    const lost = vi.fn();
    api.onSessionLost(lost);
    api.setToken('old');
    await expect(api.request('GET', '/api/me')).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalledOnce();
    expect(api.getToken()).toBeNull();
  });

  it('never refreshes for auth: none requests (a wrong password is not an expired session)', async () => {
    const m = mockFetch({ 'POST /api/users/login': { status: 401, body: { detail: 'Invalid credentials' } } });
    const api = createApiClient({ fetchImpl: m.fetch });
    await expect(api.request('POST', '/api/users/login', { auth: 'none', body: {} })).rejects.toThrow('Invalid credentials');
    expect(m.calls).toHaveLength(1);
  });

  it('turns network failures into a friendly ApiError', async () => {
    const api = createApiClient({ fetchImpl: (async () => { throw new TypeError('fail'); }) as typeof fetch });
    await expect(api.request('GET', '/api/x')).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/Cannot reach/) });
  });

  it('exposes response headers for idempotent replays', async () => {
    const m = mockFetch({ 'POST /api/orders': { status: 200, body: { id: 'o1' }, headers: { 'Idempotent-Replayed': 'true' } } });
    const api = createApiClient({ fetchImpl: m.fetch });
    const res = await api.requestRaw('POST', '/api/orders', { body: {} });
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
  });
});
