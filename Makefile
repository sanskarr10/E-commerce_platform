COMPOSE := docker compose --env-file .env -f deploy/docker-compose.yml
USER_DIR := services/user-service
PRODUCT_DIR := services/product-service
ORDER_DIR := services/order-service
PAYMENT_DIR := services/payment-service
NOTIFICATION_DIR := services/notification-service
FRONTEND_DIR := frontend

.DEFAULT_GOAL := help
.PHONY: help up down logs ps keys test lint fmt install-dev smoke seed backup clean web-install web-dev web-mock

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.env:
	cp .env.example .env
	@echo "Created .env from .env.example. Edit the passwords before deploying anywhere real."

deploy/keys/jwt_private.pem:
	./scripts/gen-keys.sh

keys: deploy/keys/jwt_private.pem ## Generate the dev JWT key pair

up: .env keys ## Build and start the whole stack
	$(COMPOSE) up --build -d --wait
	./scripts/healthcheck.sh http://localhost:8080 60
	@echo "Gateway: http://localhost:8080"
	@echo "Swagger: http://localhost:8080/api/{users,products,orders,payments}/docs"
	@echo "RabbitMQ UI: http://localhost:15672 (user/password from .env)"
	@echo "Next:    make seed   (sample products)   make smoke   (end-to-end checks)"

down: ## Stop the stack (keeps volumes)
	$(COMPOSE) down

logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=100

ps: ## Show container status
	$(COMPOSE) ps

install-dev: ## Install dev dependencies for all services
	pip install -r $(USER_DIR)/requirements-dev.txt -r $(ORDER_DIR)/requirements-dev.txt -r $(PAYMENT_DIR)/requirements-dev.txt
	cd $(PRODUCT_DIR) && npm ci
	cd $(NOTIFICATION_DIR) && npm ci

test: ## Run unit tests for all services (no Docker needed)
	cd $(USER_DIR) && python -m pytest --cov=app --cov-report=term-missing
	cd $(ORDER_DIR) && python -m pytest
	cd $(PAYMENT_DIR) && python -m pytest
	cd $(PRODUCT_DIR) && npm test
	cd $(NOTIFICATION_DIR) && npm test
	cd $(FRONTEND_DIR) && npm test

lint: ## Lint all services and the shell scripts
	cd $(USER_DIR) && ruff check . && ruff format --check .
	cd $(ORDER_DIR) && ruff check . && ruff format --check .
	cd $(PAYMENT_DIR) && ruff check . && ruff format --check .
	cd $(PRODUCT_DIR) && npm run lint
	cd $(NOTIFICATION_DIR) && npm run lint
	cd $(FRONTEND_DIR) && npm run lint && npm run typecheck
	@command -v shellcheck >/dev/null && shellcheck scripts/*.sh || echo "(shellcheck not installed, skipped)"

fmt: ## Auto-format the Python services
	cd $(USER_DIR) && ruff check --fix . && ruff format .
	cd $(ORDER_DIR) && ruff check --fix . && ruff format .
	cd $(PAYMENT_DIR) && ruff check --fix . && ruff format .

web-install: ## Install the frontend dependencies
	cd $(FRONTEND_DIR) && npm ci

web-mock: ## Run the fake API (no Docker) for working on the frontends
	cd $(FRONTEND_DIR) && npm run dev:mock

web-dev: ## Storefront on :5173 and admin on :5174 against the real gateway (run `make up` first)
	cd $(FRONTEND_DIR) && (npm run dev:admin & npm run dev:storefront; wait)

seed: ## Load sample categories and products into the running catalog
	$(COMPOSE) exec product-service node src/seed.js

smoke: ## Run the end-to-end smoke tests against the running stack
	./scripts/smoke-test.sh http://localhost:8080
	./scripts/smoke-test-products.sh http://localhost:8080
	./scripts/smoke-test-orders.sh http://localhost:8080
	./scripts/smoke-test-notifications.sh http://localhost:8080

backup: ## Dump all databases into ./backups
	./scripts/db-backup.sh

clean: ## Stop the stack and delete its volumes (destroys data)
	$(COMPOSE) down -v
