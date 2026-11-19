COMPOSE := docker compose --env-file .env -f deploy/docker-compose.yml
SERVICE_DIR := services/user-service

.DEFAULT_GOAL := help
.PHONY: help up down logs ps keys test lint fmt install-dev smoke backup clean

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
	@echo "Gateway: http://localhost:8080   Swagger: http://localhost:8080/api/users/docs"

down: ## Stop the stack (keeps volumes)
	$(COMPOSE) down

logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=100

ps: ## Show container status
	$(COMPOSE) ps

install-dev: ## Install user-service dev dependencies
	pip install -r $(SERVICE_DIR)/requirements-dev.txt

test: ## Run user-service tests with coverage
	cd $(SERVICE_DIR) && python -m pytest --cov=app --cov-report=term-missing

lint: ## Lint and format-check user-service and shell scripts
	cd $(SERVICE_DIR) && ruff check . && ruff format --check .
	@command -v shellcheck >/dev/null && shellcheck scripts/*.sh || echo "(shellcheck not installed, skipped)"

fmt: ## Auto-format user-service
	cd $(SERVICE_DIR) && ruff check --fix . && ruff format .

smoke: ## Run the end-to-end smoke test against the running stack
	./scripts/smoke-test.sh http://localhost:8080

backup: ## Dump all databases into ./backups
	./scripts/db-backup.sh

clean: ## Stop the stack and delete its volumes (destroys data)
	$(COMPOSE) down -v
