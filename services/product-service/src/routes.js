import express from 'express';
import { HttpError, notFound } from './errors.js';
import {
  categorySchema,
  createProductSchema,
  idSchema,
  idsSchema,
  listQuerySchema,
  stockSchema,
  updateProductSchema,
} from './validation.js';

/** Validates input and reports problems in the same shape FastAPI uses: { detail: [{loc,msg}] }. */
function parse(schema, data, where) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(
      422,
      result.error.issues.map((issue) => ({ loc: [where, ...issue.path], msg: issue.message, type: issue.code })),
    );
  }
  return result.data;
}

export function createProductRouter({ service, auth }) {
  const router = express.Router();
  const send = (res, { value, cache }) => res.set('X-Cache', cache).json(value);

  // Static paths are declared before '/:id' so "categories" is never read as an id.
  router.get('/categories', async (_req, res) => send(res, await service.listCategories()));

  router.post('/categories', auth.requireAdmin, async (req, res) => {
    const { name } = parse(categorySchema, req.body ?? {}, 'body');
    res.status(201).json(await service.createCategory(name));
  });

  // Used by the order service at checkout: one round trip for every line of the cart.
  router.get('/batch', async (req, res) => {
    const ids = parse(idsSchema, req.query.ids ?? '', 'query');
    res.json({ items: await service.getMany(ids) });
  });

  router.get('/', async (req, res) => {
    send(res, await service.list(parse(listQuerySchema, req.query, 'query')));
  });

  router.post('/', auth.requireAdmin, async (req, res) => {
    const data = parse(createProductSchema, req.body ?? {}, 'body');
    res.status(201).json(await service.create({ currency: 'INR', stock: 0, is_active: true, ...data }));
  });

  router.get('/:id', async (req, res) => {
    const result = await service.get(parse(idSchema, req.params.id, 'path'));
    if (!result.value) throw notFound('Product');
    send(res, result);
  });

  router.patch('/:id', auth.requireAdmin, async (req, res) => {
    const id = parse(idSchema, req.params.id, 'path');
    res.json(await service.update(id, parse(updateProductSchema, req.body ?? {}, 'body')));
  });

  router.patch('/:id/stock', auth.requireAdmin, async (req, res) => {
    const id = parse(idSchema, req.params.id, 'path');
    const { delta } = parse(stockSchema, req.body ?? {}, 'body');
    res.json(await service.adjustStock(id, delta));
  });

  router.delete('/:id', auth.requireAdmin, async (req, res) => {
    await service.archive(parse(idSchema, req.params.id, 'path'));
    res.status(204).end();
  });

  return router;
}
