export interface MockCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = Reply | ((call: MockCall) => Reply | Promise<Reply>);

/** A tiny fetch double: routes are "METHOD /path" (query string ignored), handlers may be a function or a fixed reply. */
export function mockFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: MockCall[] = [];
  const queues = new Map<string, Handler[]>();
  for (const [key, value] of Object.entries(routes)) queues.set(key, Array.isArray(value) ? [...value] : [value]);

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: MockCall = {
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = `${method} ${url.split('?')[0]}`;
    const queue = queues.get(key);
    if (!queue || queue.length === 0) return new Response(JSON.stringify({ detail: `no mock for ${key}` }), { status: 500 });
    const handler = queue.length > 1 ? queue.shift()! : queue[0]!;
    const reply = typeof handler === 'function' ? await handler(call) : handler;
    const status = reply.status ?? 200;
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return new Response(status === 204 ? null : text, { status, headers: reply.headers });
  }) as typeof fetch;

  return { fetch: impl, calls };
}
