# E-commerce Microservices Platform

A polyglot microservices e-commerce backend built to demonstrate service boundaries, event-driven
design, and a production-style DevOps workflow: Docker, Nginx gateway, GitHub Actions, and Kubernetes.

> **Status: Phase 1 complete.** The infrastructure, API gateway, CI pipeline and the **User Service**
> are implemented and tested. The remaining services are scaffolded and tracked in the [roadmap](#roadmap).
> Replace `<you>/<repo>` in the badge below after pushing to GitHub.

![user-service](https://github.com/<you>/<repo>/actions/workflows/user-service.yml/badge.svg)
![platform-checks](https://github.com/<you>/<repo>/actions/workflows/platform-checks.yml/badge.svg)

## Architecture

```
  React storefront ─┐
  React admin ──────┤
                    ▼
            ┌───────────────┐   /api/users     ──► User Service      (FastAPI)  ──► PostgreSQL users_db
            │ Nginx gateway │   /api/products  ──► Product Service   (Node.js)  ──► MySQL catalog
            │ rate limiting │   /api/orders    ──► Order Service     (FastAPI)  ──► PostgreSQL orders_db
            │ X-Request-ID  │   /api/payments  ──► Payment Service   (FastAPI)  ──► PostgreSQL payments_db
            └───────────────┘
                                   RabbitMQ (events)  ◄──►  Notification Service (Node.js)
                                   Redis (cache, rate limits)
```

Each service owns its database. Services never query each other's data; they talk over HTTP or events.

### Planned checkout flow (saga, choreography)

`order.created` → stock reserved (`stock.reserved` / `stock.failed`) → payment charged
(`payment.succeeded` / `payment.failed`) → order `PAID` or `CANCELLED` (with a compensating stock
release) → notification sent. Consumers are idempotent; failures go to a dead-letter queue.

## Quick start

Requirements: Docker with Compose v2, `openssl`, `make`, `curl`, `jq`.

```bash
make up      # creates .env + JWT keys, builds, starts the stack, waits until healthy
make smoke   # end-to-end check: register, login, /me, refresh, logout
```

- Gateway: http://localhost:8080
- Swagger UI (user-service): http://localhost:8080/api/users/docs
- RabbitMQ management UI: http://localhost:15672 (localhost only)
- A bootstrap admin is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`. **Change these.**

`make help` lists every target (`logs`, `ps`, `test`, `lint`, `backup`, `down`, `clean`).

## What is implemented

| Component | Status | Notes |
|---|---|---|
| Docker Compose stack | Done | PostgreSQL, MySQL, Redis, RabbitMQ, user-service, gateway; healthchecks and `depends_on` ordering |
| Nginx gateway | Done | Path routing, per-endpoint rate limits (stricter on auth), `X-Request-ID` correlation id, JSON 503 when a service is down |
| **User Service** | Done | Register, login, rotating refresh tokens, profile, admin user list; 30 tests, ~97% coverage |
| GitHub Actions CI | Done | Path-filtered pipeline: lint, tests, migrations on real PostgreSQL, Trivy scan, push to GHCR |
| Bash tooling | Done | `gen-keys`, `healthcheck`, `smoke-test`, `db-backup` (all ShellCheck-clean) |
| Product, Order, Payment, Notification services | Planned | Gateway routes already exist and return 503 until they are built |
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

## Security design

- **JWT RS256.** Only the user-service holds the private key. Every other service verifies tokens with
  the public key alone, so a compromised downstream service cannot mint tokens.
- **Verifier hardening.** The algorithm is pinned to RS256 and `iss`, `aud`, `exp`, `iat`, `sub` are required.
  Tests cover tampered, expired, wrong-key, wrong-audience, `alg=none` and HS256 algorithm-confusion tokens.
- **Refresh token rotation with reuse detection.** Tokens are single-use and stored only as SHA-256 hashes.
  Replaying a used token revokes every session of that user.
- **Passwords** hashed with Argon2id. Login runs a dummy verification for unknown emails so response time
  does not reveal whether an account exists, and the error message is identical either way.
- **Gateway rate limiting** on credential endpoints (5 req/s per IP, small burst).
- **Containers** run as a fixed non-root UID, multi-stage build, no secrets in the image or repo.

## CI/CD

`.github/workflows/user-service.yml` runs only when that service changes:

1. **test**: ruff, pytest (coverage gate 85%), then Alembic migrations against a real PostgreSQL service container
2. **scan**: builds the image and fails on fixable HIGH/CRITICAL vulnerabilities (Trivy). This job has no secrets and no write permissions
3. **publish**: on `main` only, pushes `:<sha>` and `:latest` to GHCR

`platform-checks.yml` runs ShellCheck, validates the Compose file and runs `nginx -t` on the gateway config.
Dependabot keeps pip, Docker and Action versions current.

> **Supply-chain note:** `aquasecurity/trivy-action` tags up to 0.34.2 were compromised in March 2026
> ([GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)).
> The workflow pins `0.35.0` and Trivy `v0.69.3`. For stronger guarantees, pin Actions to full commit SHAs.

## Design decisions and trade-offs

- **Two databases (PostgreSQL + MySQL).** Orders and payments need strict transactions and constraints,
  so they use PostgreSQL. The read-heavy product catalog uses MySQL. The split is deliberate to show both;
  in a real system you would likely standardize on one to reduce operational cost.
- **Choreography over orchestration.** Services react to events and there is no central coordinator, which keeps
  coupling low. The cost is that the end-to-end flow is harder to see, so correlation IDs and tracing matter.
- **Stateless access tokens, stateful refresh tokens.** Access tokens verify without a network call.
  The trade-off is that a revoked or deactivated user keeps a valid access token until it expires
  (15 minutes). The user-service itself re-checks the user on every request, other services would not.
- **Gateway resolves upstreams per request.** It starts even if a service is down and returns a clean 503.
  It will not notice an IP change unless the DNS TTL (`valid=10s`) expires.

## Development

```bash
python -m venv .venv && source .venv/bin/activate
make install-dev
make test      # pytest with coverage (uses SQLite, no Docker needed)
make lint      # ruff + shellcheck
```

Create a migration after changing models:

```bash
cd services/user-service
DATABASE_URL=postgresql+psycopg://... JWT_PRIVATE_KEY_PATH=/dev/null JWT_PUBLIC_KEY_PATH=/dev/null \
  alembic revision --autogenerate -m "describe change"
```

## Roadmap

- [x] Phase 1: infrastructure, gateway, User Service, CI
- [ ] Phase 2: Product Service (Node.js + MySQL, Redis caching with invalidation)
- [ ] Phase 3: Order and Payment services, RabbitMQ saga, idempotency keys
- [ ] Phase 4: React storefront and admin panel
- [ ] Phase 5: Notification service, Prometheus metrics, Grafana dashboard
- [ ] Phase 6: Helm chart, HPA, Ingress, deploy to k3s, optional Argo CD and k6 load tests
