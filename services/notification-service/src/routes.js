import { Router } from 'express';
import { z } from 'zod';
import { HttpError, notFound } from './errors.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.enum(['true', 'false']).default('false'),
});

const present = ({ id, type, order_id, title, body, created_at, read_at }) => ({
  id,
  type,
  order_id,
  title,
  body,
  created_at,
  read_at,
});

export function createRouter({ repo, auth }) {
  const router = Router();
  router.use(auth.requireUser);

  router.get('/', async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw new HttpError(422, parsed.error.issues.map((i) => ({ loc: ['query', ...i.path], msg: i.message, type: i.code })));
    const { page, page_size: pageSize, unread } = parsed.data;
    const result = await repo.list(req.user.id, { unreadOnly: unread === 'true', page, pageSize });
    res.json({ items: result.items.map(present), total: result.total, unread: result.unread, page, page_size: pageSize });
  });

  // Declared before "/:id/read" so "read-all" is never parsed as an id.
  router.post('/read-all', async (req, res) => {
    res.json({ updated: await repo.markAllRead(req.user.id) });
  });

  router.post('/:id/read', async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) throw notFound('Notification');
    const row = await repo.markRead(req.user.id, req.params.id);
    if (!row) throw notFound('Notification');
    res.json(present(row));
  });

  return router;
}
