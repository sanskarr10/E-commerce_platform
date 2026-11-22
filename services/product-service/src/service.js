import { createHash } from 'node:crypto';
import { HttpError } from './errors.js';
import { slugify } from './validation.js';

const LIST_NAMESPACE = 'products:list';

/** Fixed key order and explicit nulls, so equal queries always hash to the same cache key. */
function normalize(filters) {
  return {
    q: filters.q ?? null,
    category: filters.category ?? null,
    min_price: filters.min_price ?? null,
    max_price: filters.max_price ?? null,
    in_stock: filters.in_stock ?? false,
    sort: filters.sort ?? 'newest',
    page: filters.page ?? 1,
    page_size: filters.page_size ?? 20,
  };
}

/**
 * Cache-aside logic on top of the repository.
 *
 * - Detail pages:  key `product:{id}`, deleted on every change to that product.
 * - Listings:      key embeds a namespace VERSION. Any catalog change bumps the version, which
 *                  invalidates every cached listing at once in O(1) (no SCAN/KEYS needed).
 * - Stock changes: delete only the detail key and leave listings alone. Listings may show a
 *                  stale in_stock filter for up to the list TTL. Checkout always checks stock
 *                  atomically in MySQL, so this never causes overselling, and it stops a flash
 *                  sale from wiping the listing cache on every order.
 */
export class ProductService {
  #inflight = new Map();

  constructor({ repo, cache, ttl, logger }) {
    this.repo = repo;
    this.cache = cache;
    this.ttl = ttl;
    this.logger = logger;
  }

  /**
   * Read through the cache. Concurrent misses for the same key share ONE database query
   * (single-flight), which protects MySQL from a stampede when a hot key expires.
   * Not-found results are never cached.
   */
  async #cached(key, ttl, load) {
    const hit = await this.cache.getJson(key);
    if (hit !== null) return { value: hit, cache: 'HIT' };

    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const value = await load();
        if (value !== null && value !== undefined) await this.cache.setJson(key, value, ttl);
        return value;
      })().finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return { value: await pending, cache: 'MISS' };
  }

  async list(filters) {
    const normalized = normalize(filters);
    const version = await this.cache.version(LIST_NAMESPACE);
    if (version === null) return { value: await this.repo.list(normalized), cache: 'BYPASS' };

    const digest = createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
    return this.#cached(`${LIST_NAMESPACE}:v${version}:${digest}`, this.ttl.list, () =>
      this.repo.list(normalized),
    );
  }

  get(id) {
    return this.#cached(`product:${id}`, this.ttl.product, () => this.repo.getById(id));
  }

  async #invalidateLists() {
    // If this fails the DB is already updated; stale listings then live at most `ttl.list` seconds.
    if (!(await this.cache.bump(LIST_NAMESPACE))) {
      this.logger.error('listing cache invalidation failed; listings may be stale until TTL expiry');
    }
  }

  async create(data) {
    const product = await this.repo.create(data);
    await this.#invalidateLists();
    return product;
  }

  async update(id, patch) {
    const product = await this.repo.update(id, patch);
    await this.cache.del(`product:${id}`);
    await this.#invalidateLists();
    return product;
  }

  async archive(id) {
    await this.repo.archive(id);
    await this.cache.del(`product:${id}`);
    await this.#invalidateLists();
  }

  async adjustStock(id, delta) {
    const product = await this.repo.adjustStock(id, delta);
    await this.cache.del(`product:${id}`);
    return product;
  }

  /** Saga step: hold stock for an order. Returns the outcome name for logging. */
  async reserveForOrder(envelope, data) {
    const { outcome, productIds } = await this.repo.reserveForOrder({
      eventId: envelope.id,
      orderId: data.order_id,
      items: data.items,
      correlationId: envelope.correlation_id,
    });
    await this.cache.del(...productIds.map((id) => `product:${id}`));
    return outcome;
  }

  /** Saga compensation: give the stock back. Returns the outcome name for logging. */
  async releaseForOrder(envelope, data) {
    const { outcome, productIds } = await this.repo.releaseForOrder({
      eventId: envelope.id,
      orderId: data.order_id,
    });
    await this.cache.del(...productIds.map((id) => `product:${id}`));
    return outcome;
  }

  /** Not cached on purpose: the order service wants the price and activity at the moment of checkout. */
  getMany(ids) {
    return this.repo.getManyByIds(ids);
  }

  listCategories() {
    return this.#cached('categories:all', this.ttl.categories, () => this.repo.listCategories());
  }

  async createCategory(name) {
    const slug = slugify(name);
    if (!slug) {
      throw new HttpError(422, [{ loc: ['body', 'name'], msg: 'Name must contain letters or digits', type: 'value_error' }]);
    }
    const category = await this.repo.createCategory(name, slug);
    await this.cache.del('categories:all');
    return category;
  }
}
