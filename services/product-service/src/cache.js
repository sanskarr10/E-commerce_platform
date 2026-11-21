/**
 * Redis cache wrapper. It FAILS OPEN: if Redis is slow or down, every method degrades to
 * "cache miss" and the request is served from MySQL. The cache is an optimisation, never a
 * dependency.
 */
export class RedisCache {
  #redis;
  #logger;
  #lastWarnAt = 0;

  constructor(redis, logger) {
    this.#redis = redis;
    this.#logger = logger;
  }

  #warn(operation, err) {
    // Throttled so an outage produces one line per 10 s, not one per request.
    const now = Date.now();
    if (now - this.#lastWarnAt > 10_000) {
      this.#lastWarnAt = now;
      this.#logger.warn(`cache ${operation} failed, serving from database`, { error: err.message });
    }
  }

  async getJson(key) {
    try {
      const raw = await this.#redis.get(key);
      return raw === null ? null : JSON.parse(raw);
    } catch (err) {
      this.#warn('get', err); // also covers a corrupt value: JSON.parse throws, we treat it as a miss
      return null;
    }
  }

  async setJson(key, value, ttlSeconds) {
    try {
      await this.#redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.#warn('set', err);
    }
  }

  async del(...keys) {
    if (keys.length === 0) return;
    try {
      await this.#redis.del(...keys);
    } catch (err) {
      this.#warn('del', err);
    }
  }

  /**
   * Current version number of a cache namespace, or null when Redis is unavailable
   * (callers must then bypass the cache, otherwise they could read entries of an older epoch).
   */
  async version(name) {
    try {
      const raw = await this.#redis.get(`ver:${name}`);
      return raw === null ? 0 : Number(raw);
    } catch (err) {
      this.#warn('version', err);
      return null;
    }
  }

  /** Invalidate a whole namespace in O(1): old keys embed the old version and simply expire. */
  async bump(name) {
    try {
      await this.#redis.incr(`ver:${name}`);
      return true;
    } catch (err) {
      this.#warn('bump', err);
      return false;
    }
  }

  async status() {
    try {
      await this.#redis.ping();
      return 'ok';
    } catch {
      return 'down';
    }
  }
}

/** Used when REDIS_URL is not set. Every read is a bypass. */
export class NullCache {
  async getJson() {
    return null;
  }
  async setJson() {}
  async del() {}
  async version() {
    return null;
  }
  async bump() {
    return true;
  }
  async status() {
    return 'disabled';
  }
}
