COMPOSE := docker compose --env-file .env -f deploy/docker-compose.yml
USER_DIR := services/user-service
PRODUCT_DIR := services/product-service

.DEFAULT_GOAL := help
.PHONY: help up down logs ps keys test lint fmt install-dev smoke seed backup clean

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
	@echo "Swagger: http://localhost:8080/api/users/docs  and  http://localhost:8080/api/products/docs"
	@echo "Next:    make seed   (sample products)   make smoke   (end-to-end checks)"

down: ## Stop the stack (keeps volumes)
	$(COMPOSE) down

logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=100

ps: ## Show container status
	$(COMPOSE) ps

install-dev: ## Install dev dependencies for all services
	pip install -r $(USER_DIR)/requirements-dev.txt
	cd $(PRODUCT_DIR) && npm ci

test: ## Run unit tests for all services (no Docker needed)
	cd $(USER_DIR) && python -m pytest --cov=app --cov-report=term-missing
	cd $(PRODUCT_DIR) && npm test

lint: ## Lint all services and the shell scripts
	cd $(USER_DIR) && ruff check . && ruff format --check .
	cd $(PRODUCT_DIR) && npm run lint
	@command -v shellcheck >/dev/null && shellcheck scripts/*.sh || echo "(shellcheck not installed, skipped)"

fmt: ## Auto-format the Python service
	cd $(USER_DIR) && ruff check --fix . && ruff format .

seed: ## Load sample categories and products into the running catalog
	$(COMPOSE) exec product-service node src/seed.js

smoke: ## Run the end-to-end smoke tests against the running stack
	./scripts/smoke-test.sh http://localhost:8080
	./scripts/smoke-test-products.sh http://localhost:8080

backup: ## Dump all databases into ./backups
	./scripts/db-backup.sh

clean: ## Stop the stack and delete its volumes (destroys data)
	$(COMPOSE) down -v
