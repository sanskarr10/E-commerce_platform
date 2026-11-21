# E-commerce Microservices Platform

A polyglot microservices e-commerce backend built to demonstrate service boundaries, event-driven
design, caching, and a production-style DevOps workflow: Docker, Nginx gateway, GitHub Actions, and Kubernetes.

> **Status: Phase 2 complete.** Infrastructure, API gateway, CI, the **User Service** (FastAPI) and the
> **Product Service** (Node.js) are implemented and tested. The remaining services are tracked in the
> [roadmap](#roadmap). Replace `<you>/<repo>` in the badges below after pushing to GitHub.

![user-service](https://github.com/<you>/<repo>/actions/workflows/user-service.yml/badge.svg)
![product-service](https://github.com/<you>/<repo>/actions/workflows/product-service.yml/badge.svg)
![platform-checks](https://github.com/<you>/<repo>/actions/workflows/platform-checks.yml/badge.svg)

## Architecture

```
  React storefront ─┐
  React admin ──────┤
                    ▼
            ┌───────────────┐   /api/users     ──► User Service      (FastAPI)  ──► PostgreSQL users_db
            │ Nginx gateway │   /api/products  ──► Product Service   (Node.js)  ──► MySQL catalog  + Redis cache
            │ rate limiting │   /api/orders    ──► Order Service     (FastAPI)  ──► PostgreSQL orders_db      (planned)
            │ X-Request-ID  │   /api/payments  ──► Payment Service   (FastAPI)  ──► PostgreSQL payments_db    (planned)
            └───────────────┘
                                   RabbitMQ (events)  ◄──►  Notification Service (Node.js)                   (planned)
```

Each service owns its database. Services never query each other's data; they talk over HTTP or events.
The user-service signs JWTs with a private key; every other service verifies them with the **public key only**.

### Planned checkout flow (saga, choreography)

`order.created` → stock reserved (`stock.reserved` / `stock.failed`) → payment charged
(`payment.succeeded` / `payment.failed`) → order `PAID` or `CANCELLED` (with a compensating stock
release) → notification sent. Consumers are idempotent; failures go to a dead-letter queue.
The product service already implements the atomic `reserveStock` / `releaseStock` operations this flow needs.

## Quick start

Requirements: Docker with Compose v2, `openssl`, `make`, `curl`, `jq`.

```bash
make up      # creates .env + JWT keys, builds, starts the stack, waits until healthy
make seed    # loads 4 categories and 12 sample products
make smoke   # end-to-end checks for both services (auth, CRUD, caching, invalidation)
```

- Gateway: http://localhost:8080
- Swagger UI: http://localhost:8080/api/users/docs and http://localhost:8080/api/products/docs
- RabbitMQ management UI: http://localhost:15672 (localhost only)
- A bootstrap admin is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`. **Change these.**

`make help` lists every target (`logs`, `ps`, `test`, `lint`, `backup`, `down`, `clean`).

## What is implemented

| Component | Status | Notes |
|---|---|---|
| Docker Compose stack | Done | PostgreSQL, MySQL, Redis, RabbitMQ, both services, gateway; healthchecks and `depends_on` ordering |
| Nginx gateway | Done | Path routing, per-endpoint rate limits (stricter on auth), `X-Request-ID` correlation id, JSON 503 when a service is down |
| **User Service** | Done | Register, login, rotating refresh tokens, profile, admin user list; 30 tests |
| **Product Service** | Done | Catalog CRUD, search/filter/sort/pagination, atomic stock, Redis caching, OpenAPI docs; 94 unit tests plus integration tests |
| GitHub Actions CI | Done | Path-filtered pipeline per service: lint, tests, real PostgreSQL/MySQL/Redis, Trivy scan, push to GHCR |
| Bash tooling | Done | `gen-keys`, `healthcheck`, `smoke-test`, `smoke-test-products`, `db-backup` (all ShellCheck-clean) |
| Order, Payment, Notification services | Planned | Gateway routes already exist and return 503 until they are built |
| React storefront and admin | Planned | |
| Helm chart / Kubernetes | Planned | |

## User Service API

All paths are served under `/api/users`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | none | Create a customer account (role cannot be chosen by the client) |
| POST | `/login` | none | Returns a 15-minute access token and sets an httpOnly refresh cookie |
| POST | `/refresh` | cookie | Rotates the refresh token and returns a new access token |
| POST | `/logout` | cookie | Revokes the refresh token |
| GET | `/me` | Bearer | Current profile |
| PATCH | `/me` | Bearer | Update full name |
| GET | `/` (the collection) | Bearer, admin | Paginated user list (`skip`, `limit`) |

Probes: `GET /health` (liveness) and `GET /ready` (readiness, checks the database).

## Product Service API

All paths are served under `/api/products`. Reads are public; writes require an **admin** access token
issued by the user-service. Prices are integers in **minor units** (`49900` = INR 499.00) with an ISO currency code.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | none | Search and list. Query: `q`, `category` (slug), `min_price`, `max_price`, `in_stock`, `sort` (`newest`, `price_asc`, `price_desc`, `name`), `page`, `page_size` (max 100) |
| GET | `/{id}` | none | One product (archived products return 404) |
| POST | `/` | admin | Create a product |
| PATCH | `/{id}` | admin | Partial update (SKU is immutable; stock changes go through `/stock`) |
| PATCH | `/{id}/stock` | admin | Atomically add or remove stock with `{ "delta": -3 }`; 409 if it would go negative |
| DELETE | `/{id}` | admin | Archive (soft delete, so orders can keep referencing the product) |
| GET / POST | `/categories` | none / admin | List or create categories |

Read responses carry an `X-Cache: HIT | MISS | BYPASS` header. Errors use the same `{ "detail": ... }` shape as the
FastAPI service, and validation errors list `loc` and `msg` per field, so one client can handle both services.
Probes: `GET /health` and `GET /ready` (MySQL must answer; Redis being down only degrades speed).

## Caching design (Product Service)

Redis is used cache-aside, and it is an optimisation, never a dependency.

- **Detail pages** are cached per product and deleted on every change to that product.
- **Listings** are cached under keys that embed a namespace **version**. Any catalog change increments the
  version, which invalidates every cached listing at once in O(1), with no `KEYS`/`SCAN`. Old entries simply expire.
- **Stock changes** delete only the detail entry and leave listings alone. A listing's `in_stock` filter can be
  stale for up to the list TTL (60 s). Checkout always checks stock atomically in MySQL, so this can never oversell,
  and a flash sale does not wipe the listing cache on every order.
- **Single-flight:** concurrent misses for the same key share one database query, so an expiring hot key cannot stampede MySQL.
- **Fail open:** if Redis is slow or down, every cache call degrades to a miss and requests go straight to MySQL
  (`X-Cache: BYPASS`). The client uses no offline queue and short timeouts so a Redis outage cannot pile up requests.
- **Not-found is never cached**, so a newly created product is visible immediately.

Known limitation (bounded staleness): a reader that misses, loads from MySQL, and is overtaken by a write before it
stores its result can cache the old value until its TTL expires (5 minutes for detail pages, 60 s for listings).
Closing that window completely needs versioned detail keys or write-through caching, which is deliberately left out.

## Security design

- **JWT RS256.** Only the user-service holds the private key. The product service gets a mount of the public key
  file only, so a compromised downstream service cannot mint tokens.
- **Verifier hardening (both services).** The algorithm is pinned to RS256, and issuer, audience, expiry and subject
  are required. Tests cover tampered, expired, wrong-key, wrong-audience, `alg=none`, HS256 key-confusion, and
  validly signed tokens with no expiry.
- **Refresh token rotation with reuse detection.** Tokens are single-use and stored only as SHA-256 hashes.
  Replaying a used token revokes every session of that user.
- **Passwords** hashed with Argon2id. Login runs a dummy verification for unknown emails so response time
  does not reveal whether an account exists, and the error message is identical either way.
- **Input handling.** All SQL values are bound parameters, `ORDER BY` comes from a whitelist, LIKE wildcards in search
  text are escaped, image URLs must be http(s), and unknown JSON fields are rejected instead of ignored.
- **Gateway rate limiting** on credential endpoints (5 req/s per IP, small burst).
- **Containers** run as a fixed non-root UID, multi-stage builds, no secrets in images or the repo.

## Testing

| Layer | Service | What it covers | Needs |
|---|---|---|---|
| Unit and HTTP | user-service (30) | Auth flows, token attacks, admin routes, bootstrap | nothing (SQLite) |
| Unit and HTTP | product-service (94) | Validation, query builder, JWT verification, routes, cache behaviour, OpenAPI drift guard | nothing (in-memory fakes) |
| Integration | product-service | `RedisCache` against real Redis (TTL, versions, outage fail-open, corrupt values) | `REDIS_URL` |
| Integration | product-service | Real MySQL: migrations with concurrent replicas, filters, LIKE escaping, **atomic stock and oversell race**, all-or-nothing reservations, deadlock avoidance | `MYSQL_HOST` and a database whose name contains `test` |
| End-to-end | whole stack | `make smoke` through the gateway with real tokens | `make up` |

Unit tests of the product service cover 100% of lines in the modules they load. The repository, Redis client,
migrations and seed are exercised by the integration suites, which run in CI against real MySQL 8.4 and Redis 7.
The suites skip themselves when their environment variables are not set, and the MySQL suite refuses to run
destructively on a database whose name does not contain `test`.

## CI/CD

Each service has a path-filtered workflow (`user-service.yml`, `product-service.yml`) that runs only when that
service changes:

1. **test**: lint, unit tests with a coverage gate, then migrations/integration tests against real service containers
2. **scan**: builds the image and fails on fixable HIGH/CRITICAL vulnerabilities (Trivy). This job has no secrets and no write permissions
3. **publish**: on `main` only, pushes `:<sha>` and `:latest` to GHCR

`platform-checks.yml` runs ShellCheck, validates the Compose file and runs `nginx -t` on the gateway config.
Dependabot keeps pip, npm, Docker and Action versions current.

> **Supply-chain note:** `aquasecurity/trivy-action` tags up to 0.34.2 were compromised in March 2026
> ([GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)).
> The workflows pin `0.35.0` and Trivy `v0.69.3`. For stronger guarantees, pin Actions to full commit SHAs.

## Design decisions and trade-offs

- **Two databases (PostgreSQL + MySQL).** Orders and payments need strict transactions and constraints,
  so they use PostgreSQL. The read-heavy product catalog uses MySQL. The split is deliberate to show both;
  in a real system you would likely standardize on one to reduce operational cost.
- **Choreography over orchestration.** Services react to events and there is no central coordinator, which keeps
  coupling low. The cost is that the end-to-end flow is harder to see, so correlation IDs and tracing matter.
- **Stateless access tokens, stateful refresh tokens.** Access tokens verify without a network call.
  The trade-off is that a revoked or deactivated user keeps a valid access token until it expires (15 minutes).
  The user-service re-checks the user on every request; the product service does not.
- **Money as integer minor units.** No floating point anywhere in the price path.
- **Atomic stock in one statement.** `UPDATE ... SET stock = stock - ? WHERE id = ? AND stock >= ?` makes the check and
  the write indivisible, so there is no read-then-write race. Multi-item reservations lock rows in id order
  and retry on deadlock.
- **Soft delete for products.** Orders keep referencing archived products. The trade-off is that admins currently
  cannot list archived products through the API.
- **LIKE search.** Simple and index-friendly enough for a catalog this size. At scale, replace it with MySQL FULLTEXT
  or OpenSearch.
- **Gateway resolves upstreams per request.** It starts even if a service is down and returns a clean 503.
  It will not notice an IP change unless the DNS TTL (`valid=10s`) expires.

## Development

```bash
make install-dev   # pip install for the Python service, npm ci for the Node service
make test          # unit tests for both services, no Docker needed
make lint          # ruff, eslint, shellcheck
```

Integration tests for the product service (use a throwaway database, its name must contain `test`):

```bash
cd services/product-service
REDIS_URL=redis://localhost:6379 \
MYSQL_HOST=127.0.0.1 MYSQL_USER=ci MYSQL_PASSWORD=ci MYSQL_DATABASE=catalog_test \
  npm run test:integration
```

Create a user-service migration after changing its models:

```bash
cd services/user-service
DATABASE_URL=postgresql+psycopg://... JWT_PRIVATE_KEY_PATH=/dev/null JWT_PUBLIC_KEY_PATH=/dev/null \
  alembic revision --autogenerate -m "describe change"
```

Product-service migrations are plain SQL files in `services/product-service/migrations/`, applied in filename order
and recorded in `schema_migrations`. A MySQL advisory lock makes concurrent replica starts safe.

## Roadmap

- [x] Phase 1: infrastructure, gateway, User Service, CI
- [x] Phase 2: Product Service (Node.js + MySQL, Redis caching with invalidation)
- [ ] Phase 3: Order and Payment services, RabbitMQ saga, idempotency keys
- [ ] Phase 4: React storefront and admin panel
- [ ] Phase 5: Notification service, Prometheus metrics, Grafana dashboard
- [ ] Phase 6: Helm chart, HPA, Ingress, deploy to k3s, optional Argo CD and k6 load tests
