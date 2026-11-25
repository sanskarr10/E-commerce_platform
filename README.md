# E-commerce Microservices Platform

A polyglot microservices e-commerce backend built to demonstrate service boundaries, event-driven
design, caching, and a production-style DevOps workflow: Docker, Nginx gateway, GitHub Actions, and Kubernetes.

> **Status: Phase 5 complete.** Infrastructure, API gateway, CI, the **User**, **Product**, **Order**, **Payment** and
> **Notification** services (including the RabbitMQ checkout saga), the React **storefront** and **admin**, and
> **Prometheus + Grafana** observability are implemented. The rest is in the
> [roadmap](#roadmap). Replace `<you>/<repo>` in the badges below after pushing to GitHub.

![user-service](https://github.com/<you>/<repo>/actions/workflows/user-service.yml/badge.svg)
![product-service](https://github.com/<you>/<repo>/actions/workflows/product-service.yml/badge.svg)
![order-service](https://github.com/<you>/<repo>/actions/workflows/order-service.yml/badge.svg)
![payment-service](https://github.com/<you>/<repo>/actions/workflows/payment-service.yml/badge.svg)
![notification-service](https://github.com/<you>/<repo>/actions/workflows/notification-service.yml/badge.svg)
![frontend](https://github.com/<you>/<repo>/actions/workflows/frontend.yml/badge.svg)
![platform-checks](https://github.com/<you>/<repo>/actions/workflows/platform-checks.yml/badge.svg)

## Architecture

```
  React storefront ─┐
  React admin ──────┤
                    ▼
            ┌───────────────┐   /api/users     ──► User Service      (FastAPI)  ──► PostgreSQL users_db
            │ Nginx gateway │   /api/products  ──► Product Service   (Node.js)  ──► MySQL catalog  + Redis cache
            │ rate limiting │   /api/orders    ──► Order Service     (FastAPI)  ──► PostgreSQL orders_db
            │ X-Request-ID  │   /api/payments  ──► Payment Service   (FastAPI)  ──► PostgreSQL payments_db
            └───────────────┘
                                   RabbitMQ (events)  ◄──►  Order ⇄ Product ⇄ Payment      Notification Service  ──► PostgreSQL notifications_db + SMTP
```

Each service owns its database. Services never query each other's data; they talk over HTTP or events.
The user-service signs JWTs with a private key; every other service verifies them with the **public key only**.

### Checkout saga

Placing an order returns immediately with status `PENDING`; the rest happens asynchronously over RabbitMQ.
The **Order service coordinates** the saga and owns the order status.

```
POST /api/orders (Idempotency-Key)  →  order PENDING, order.created
  Product service: reserve stock (all or nothing)  →  stock.reserved | stock.failed
  Order service:   STOCK_RESERVED, payment.requested         (or CANCELLED: out_of_stock)
  Payment service: charge with an idempotency key  →  payment.succeeded | payment.failed
  Order service:   PAID, order.confirmed                      (or CANCELLED: payment_failed, order.cancelled)
  Product service: order.cancelled  →  release the reserved stock (compensation)
```

Every service uses a **transactional outbox** (state change and event are one database transaction, published
afterwards with publisher confirms) and an **idempotent inbox** (event id recorded with the effect), so delivery
is at-least-once but effects happen once. Failures retry through a TTL queue and end in a dead-letter queue.
The full contract, sequence diagram, state machine and failure table are in [`docs/events/`](docs/events/README.md),
with JSON fixtures that every service's contract tests load.

## Quick start

Requirements: Docker with Compose v2, `openssl`, `make`, `curl`, `jq`.

```bash
make up      # creates .env + JWT keys, builds, starts the stack, waits until healthy
make seed    # loads 4 categories and 12 sample products
make smoke   # end-to-end checks: auth, catalog, caching, and the whole checkout saga
```

- Storefront: http://localhost:8081 (sign up, add to cart, pay with a test card, watch the order progress)
- Admin: http://localhost:8082 (sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`)
- Gateway and API: http://localhost:8080
- Swagger UI: `/api/users/docs`, `/api/products/docs`, `/api/orders/docs`, `/api/payments/docs` on the gateway
- Grafana: http://localhost:3001 (user `admin`, password `GRAFANA_ADMIN_PASSWORD` from `.env`; dashboard "Shop overview")
- Prometheus: http://localhost:9090 (targets and alerts)
- Mailpit inbox: http://localhost:8025 (every email the shop sends lands here, nothing leaves your machine)
- RabbitMQ management UI: http://localhost:15672 (localhost only)
- A bootstrap admin is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`. **Change these.**

`make help` lists every target (`logs`, `ps`, `test`, `lint`, `backup`, `down`, `clean`).

## What is implemented

| Component | Status | Notes |
|---|---|---|
| Docker Compose stack | Done | PostgreSQL, MySQL, Redis, RabbitMQ, four services, gateway; healthchecks and `depends_on` ordering |
| Nginx gateway | Done | Path routing, per-endpoint rate limits (stricter on auth), `X-Request-ID` correlation id, JSON 503 when a service is down |
| **User Service** | Done | Register, login, rotating refresh tokens, profile, admin user list; 37 tests |
| **Product Service** | Done | Catalog CRUD, search/filter/sort/pagination, atomic stock, Redis caching, per-order stock reservation and release over events, batch lookup, OpenAPI docs |
| **Order Service** | Done | Idempotent order placement, price snapshot, state machine, saga coordinator, admin fulfilment, outbox relay |
| **Payment Service** | Done | Mock provider with idempotent charges, exactly-once charging, outcome events, read-only API |
| GitHub Actions CI | Done | Path-filtered pipeline per service: lint, tests, real PostgreSQL/MySQL/Redis, Trivy scan, push to GHCR |
| Bash tooling | Done | `gen-keys`, `healthcheck`, `smoke-test`, `smoke-test-products`, `smoke-test-orders`, `db-backup` (all ShellCheck-clean) |
| **Notification Service** | Done | Consumes `order.confirmed/shipped/delivered/cancelled`, stores one in-app notification per order and event type, emails the customer over SMTP, REST API to list and mark read |
| **Observability** | Done | `/metrics` on every service, Prometheus with 12 alert rules (unit-tested with promtool), provisioned Grafana dashboard, per-queue RabbitMQ metrics |
| **React storefront** | Done | Catalog with search/filter/sort, cart, checkout with an Idempotency-Key, **live order tracker** that follows the saga, my orders |
| **React admin** | Done | Admin-only sign in, product CRUD, stock adjustment, archive, categories, order fulfilment, payments |
| Helm chart / Kubernetes | Planned | |

## Notification Service

Node.js + PostgreSQL (`notifications_db`). It only **consumes** events, so it needs no outbox. Order events carry
`user_id` and `user_email`, a snapshot of the JWT `email` claim taken when the order was placed, so the service never
calls the user service. A token without an email still produces the in-app notification; only the email is skipped.

- **Idempotent by construction.** `(order_id, type)` is unique, so a redelivered event, or the same event re-emitted with a new id, creates no second notification. The email is *claimed* (`pending` -> `sending` with a lease -> `sent`), so concurrent or redelivered events never send it twice.
- **Failure handling.** A transient SMTP error (4xx, network) releases the claim and retries through the shared TTL retry queue, then the DLQ. A permanent one (550, unknown mailbox) marks the email `failed` and keeps the in-app notification.
- **At-least-once email.** If the process dies after SMTP accepted the message but before it was recorded, the lease expires and the email is sent again. That is the usual SMTP trade-off.
- **Self-provisioning.** On start it creates `notifications_db` if it does not exist (init scripts only run on a brand new volume) and applies SQL migrations under an advisory lock.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/notifications` | My notifications, newest first. `unread=true`, `page`, `page_size`. Returns `unread` (count across all pages) |
| POST | `/api/notifications/{id}/read` | Idempotent. Someone else's id returns 404 |
| POST | `/api/notifications/read-all` | Returns `{ "updated": n }` |

The storefront shows an unread badge in the header and a Notifications page.

## Observability

Every service exposes `GET /metrics` (Prometheus text format). The gateway has **no route** to it, so the endpoint is only
reachable on the internal network. Prometheus scrapes all services and RabbitMQ every 15 s.

- **Per service:** request latency histogram (labelled by route *pattern*, never the raw URL, so scanners cannot explode label cardinality), event outcomes (`events_consumed_total{outcome=processed|duplicate_*|retry|dead_letter}`), outbox backlog and age.
- **Business:** orders by status, age of the oldest unsettled order, payments by status, payment-provider call results, logins and refresh-token replays, notifications created and emails sent, product cache hits and misses.
- **Alerts** (`deploy/observability/prometheus/alerts.yml`, 12 rules): service down, 5xx rate, p95 latency, order stuck in the saga, payment stuck, provider failing, outbox stuck or backlogged, dead-lettered event, email backlog, refresh-token replay, login-failure spike. `alerts.test.yml` unit-tests them with `promtool test rules`.
- **Dashboard:** `Shop overview` is provisioned from `deploy/observability/grafana/dashboards/shop-overview.json`, so a fresh `make up` already has it.

Alert delivery (Alertmanager to Slack or PagerDuty) is deliberately not wired up: alerts are visible at http://localhost:9090/alerts.

## Frontend

`frontend/` is an npm workspace: `shared` (typed API client, auth, money, idempotency, theme), `storefront` and `admin`.
React 19, TypeScript, Vite, TanStack Query, React Router. In production each app is an nginx image serving the
static build and proxying `/api/` to the gateway, so the browser sees **one origin** and the httpOnly refresh cookie works.

- **Auth.** The access token lives in memory only. A 401 triggers one shared refresh (refresh tokens are single use) and a single retry; if it fails the session ends. On page load the app restores the session from the refresh cookie.
- **Idempotent checkout.** The Idempotency-Key is kept per cart in `sessionStorage`, so a double click, a timeout retry or a reload sends the same key and never creates a second order. It is cleared once the order exists.
- **Order tracker.** The order page polls every 1.5 s until the order is `DELIVERED` or `CANCELLED`, showing each saga step as it completes, or why it was cancelled.
- **Money** is integer minor units end to end and formatted only for display.

```bash
make web-install   # npm ci
make web-mock      # fake API on :8090 (admin@example.com / Admin123!, demo@example.com / Demo1234), no Docker needed
cd frontend && API_TARGET=http://localhost:8090 npm run dev:storefront   # http://localhost:5173
make web-dev       # or run both against the real gateway after `make up`
```

Test card tokens at checkout: `tok_success`, `tok_decline`, `tok_insufficient`, `tok_flaky` (fails once, then succeeds).

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

## Order Service API

All paths are served under `/api/orders`. Every endpoint needs a Bearer token.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/` | customer | Place an order. **Requires an `Idempotency-Key` header.** Body: `{ "items": [{ "product_id": 1, "quantity": 2 }], "payment_method": "tok_success" }`. Returns `201` (`PENDING`). A retry with the same key returns `200` with `Idempotent-Replayed: true`; the same key with a different body is `422` |
| GET | `/` | customer | My orders, newest first (`page`, `page_size`) |
| GET | `/{id}` | owner or admin | One order with its status history. Someone else's order is `404`, not `403` |
| GET | `/admin/list` | admin | All orders, optional `status` filter |
| POST | `/{id}/ship`, `/{id}/deliver` | admin | `PAID` → `SHIPPED` → `DELIVERED`; anything else is `409` |

Prices are never accepted from the client: they are read from the product service at checkout and stored as a
snapshot on the order. `payment_method` is a provider token (see below), never a card number.

## Payment Service API

Payments are created by the saga, so the HTTP API is read-only. Paths are under `/api/payments`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/orders/{order_id}` | owner or admin | The payment for an order (`404` for anyone else) |
| GET | `/admin/list` | admin | All payments, optional `status` filter |

The mock provider decides by token, which makes every saga path reproducible:

| `payment_method` | Result |
|---|---|
| `tok_success` | Approved |
| `tok_decline` / `tok_insufficient` | Declined (`card_declined` / `insufficient_funds`) → order cancelled, stock released |
| `tok_flaky` | Provider fails once, the retry succeeds |
| `tok_error` | Provider always fails → retried, then dead-lettered |

## Messaging reliability

- **Transactional outbox.** An order and its `order.created` event are one database transaction. A relay publishes
  with publisher confirms and marks a row published only after the broker confirmed it, so a crash causes a duplicate,
  never a lost event. Rows are leased and claimed with `SKIP LOCKED`, so several replicas can relay safely.
- **Idempotent inbox.** Consumers record the event id in the same transaction as the effect; a redelivery is a no-op.
- **Exactly one charge.** The payment id is the provider idempotency key and `order_id` is unique. A crash after the
  provider charged but before the result was saved is retried with the same key, so the customer is not charged twice.
- **Stock held per order.** One reservation row per order (primary key), released exactly once, with a tombstone if
  the cancellation overtakes the order.
- **Retry and dead letters.** A failed handler re-publishes to a TTL retry queue; after `EVENT_MAX_RETRIES` or on a
  permanent error (malformed payload) the message goes to `<queue>.dlq`. The message is re-published before it is
  acked, so a failure in between duplicates rather than loses it.
- **Broker down.** The HTTP APIs keep working and orders queue up in the outbox; the saga resumes when RabbitMQ returns.

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
| Unit, HTTP and database | notification-service (68 + 13) | Idempotency, email claim and retry, SMTP failure classes, contract fixtures, routes and auth, AMQP topology; the 13 integration tests run on real PostgreSQL: 10-way claim race, lease takeover, migrations under concurrency | nothing / `TEST_DATABASE_URL` |
| Unit and HTTP | user-service (37) | Auth flows, token attacks, admin routes, bootstrap | nothing (SQLite) |
| Unit and HTTP | product-service (148) | Validation, query builder, JWT verification, routes, cache, saga handlers, consumer decisions, relay, AMQP adapter (fake channel), contract fixtures, OpenAPI drift guard | nothing (in-memory fakes) |
| Unit, HTTP and saga | order-service (96) | Idempotency, state machine (every move), each saga handler and its edge cases, contract fixtures, relay, retry/DLQ decisions | nothing (SQLite) |
| Unit and saga | payment-service (61) | Mock provider, success/decline/transient/flaky, **crash after charge**, duplicate events, contract fixtures | nothing (SQLite) |
| Races on PostgreSQL | order-service, payment-service | Concurrent identical POSTs create one order, concurrent duplicate events apply once, relays never claim the same row, one charge under concurrency; the whole suite and Alembic migration/model drift check | `TEST_DATABASE_URL` |
| Integration | product-service | Real RabbitMQ: topic routing, publisher confirms, retry via TTL queue, dead-lettering | `RABBITMQ_URL` |
| Integration | product-service | `RedisCache` against real Redis (TTL, versions, outage fail-open, corrupt values) | `REDIS_URL` |
| Integration | product-service | Real MySQL: migrations with concurrent replicas, filters, LIKE escaping, **atomic stock and oversell race**, per-order reservation idempotency (also under concurrent redelivery), tombstones, deadlock avoidance, outbox claim leases | `MYSQL_HOST` and a database whose name contains `test` |
| Component and unit | frontend (78) | API client (single-flight refresh, session loss), idempotency keys, cart rules, auth bootstrap, catalog filters, checkout, polling tracker, admin access control and CRUD | nothing (jsdom) |
| End-to-end | whole stack | `make smoke` through the gateway with real tokens | `make up` |

Unit tests of the product service cover 100% of lines in the modules they load. The repository, Redis client,
migrations and seed are exercised by the integration suites, which run in CI against real MySQL 8.4 and Redis 7.
The suites skip themselves when their environment variables are not set, and the MySQL suite refuses to run
destructively on a database whose name does not contain `test`.

## CI/CD

Each service has a path-filtered workflow (`user-service.yml`, `product-service.yml`, `order-service.yml`,
`payment-service.yml`) that runs only when that service (or the shared `docs/events/` fixtures) changes:

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
- **Orchestrated saga, coordinator in the Order service.** The order status is the single source of truth and the
  flow is readable in one place (`app/events/handlers.py`). The price is that product and payment depend on the order
  service's commands; the alternative, pure choreography, spreads the flow across services and makes it harder to follow.
- **Outbox instead of dual writes.** Writing to the database and publishing to the broker in one step cannot be atomic.
  The outbox makes the database the source of truth and turns the broker into a delivery detail.
- **Duplicated messaging code on purpose.** The order and payment services contain similar relay and consumer modules.
  Independent services should not share a library at this size, and the shared event fixtures keep them honest.
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
make install-dev   # pip install for the Python services, npm ci for the Node service
make test          # unit tests for all services and the frontend, no Docker needed
make lint          # ruff, eslint, shellcheck
```

Integration tests for the product service (use a throwaway database, its name must contain `test`):

```bash
cd services/product-service
REDIS_URL=redis://localhost:6379 \
MYSQL_HOST=127.0.0.1 MYSQL_USER=ci MYSQL_PASSWORD=ci MYSQL_DATABASE=catalog_test \
  npm run test:integration
```

Order and payment tests on real PostgreSQL (the race-condition tests only run there; use a throwaway database):

```bash
cd services/order-service
TEST_DATABASE_URL=postgresql+psycopg://ci:ci@localhost:5432/orders_test pytest
```

Product-service messaging integration tests also need `RABBITMQ_URL=amqp://guest:guest@localhost:5672/`.

Create a user-service migration after changing its models (the other Python services work the same way):

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
- [x] Phase 3: Order and Payment services, RabbitMQ saga, idempotency keys
- [x] Phase 4: React storefront and admin panel
- [x] Phase 5: Notification service, Prometheus metrics, Grafana dashboard
- [ ] Phase 6: Helm chart, HPA, Ingress, deploy to k3s, optional Argo CD and k6 load tests

## Known limitations

- **No saga timeout or refunds.** An order stuck in `PENDING`/`STOCK_RESERVED` (for example after a message is dead-lettered)
  is not cancelled automatically, and a payment that succeeds for an already cancelled order is only logged as "refund
  required". A reaper job and refund flow are planned with the observability work.
- **No customer cancellation** and no `REFUNDED` state yet.
- **Outbox and inbox rows are never purged.** Add a retention job before real traffic.
- **The payment provider is a mock** that keeps its idempotency memory in the process, so a service restart forgets it.
  A real provider keeps that state itself.
- **Order creation calls the product service synchronously** (to get prices). If it is down, ordering returns `503`.
