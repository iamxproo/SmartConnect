# SmartConnect developer commands. Run `make help`. Onboarding: docs/onboarding.md
# Safety: no target here deletes Docker volumes or the dev database. Only the disposable test
# instance (tmpfs) is ever recreated.

COMPOSE := docker compose -f infrastructure/compose/docker-compose.yml --env-file .env
DB      := node infrastructure/scripts/db.mjs

# Local access-token keys (make auth-dev-keys). Used only when the variables are not already set.
AUTH_KEYS := $(CURDIR)/.secrets/auth
WITH_PUBLIC_JWKS := if [ -z "$$AUTH_JWT_PUBLIC_JWKS" ]; then export AUTH_JWT_PUBLIC_JWKS_FILE="$${AUTH_JWT_PUBLIC_JWKS_FILE:-$(AUTH_KEYS)/jwt-public.jwks.json}"; fi;
WITH_PRIVATE_JWK := if [ -z "$$AUTH_JWT_PRIVATE_JWK" ]; then export AUTH_JWT_PRIVATE_JWK_FILE="$${AUTH_JWT_PRIVATE_JWK_FILE:-$(AUTH_KEYS)/identity-jwt-private.jwk.json}"; fi;

.DEFAULT_GOAL := help
.PHONY: help install format format-check lint typecheck test-unit test-frontend web-dev gateway-dev gateway-start \
        gateway-test identity-start identity-test organization-start organization-test workspace-start workspace-test \
        messaging-start messaging-test files-start files-test realtime-start realtime-test \
        backend-start backend-test e2e-unified load-30 \
        backend-kit-test auth-dev-keys build audit ci-local \
        infra-up infra-stop infra-ps test-db-up test-db-reset test-db-stop \
        prisma-validate prisma-generate db-bootstrap db-rotate db-migrate db-status \
        db-migration db-drift db-rehearse db-rehearse-managed db-seed admin-seed db-test db-backup db-docs e2e \
        smtp-credentials smtp-check smtp-test-email organization-creators

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- Workspace ----------------------------------------------------------------------------------
install: ## Install all workspaces from the root lockfile (npm ci)
	npm ci

format: ## Format the repository with Prettier
	npm run format

format-check: ## Fail if any file is not Prettier-formatted
	npm run format:check

lint: ## ESLint the repository (type-aware; zero warnings allowed)
	npm run lint

typecheck: ## Type-check every workspace that defines a typecheck script
	npm run typecheck

test-unit: ## Unit tests (no database or Docker needed)
	npm run test:unit

test-frontend: ## Frontend tests: design tokens (contrast, drift), UI primitives, web app
	for d in smartconnect-frontend/packages/*/ smartconnect-frontend/web/; do npm run test --workspace "$${d%/}" || exit 1; done

web-dev: ## Run the web app dev server (http://127.0.0.1:5173)
	npm run dev --workspace @smartconnect/web

gateway-test: ## API gateway tests (in-process; no database, Docker or network)
	npm run test --workspace @smartconnect/api-gateway

gateway-start: ## Build and start the API gateway (http://127.0.0.1:3000; docs at /docs). Needs auth-dev-keys
	npm run build --workspace @smartconnect/api-gateway
	@$(WITH_PUBLIC_JWKS) npm run start --workspace @smartconnect/api-gateway

gateway-dev: ## Run the API gateway, rebuilding and restarting on change (http://127.0.0.1:3000)
	@$(WITH_PUBLIC_JWKS) npm run dev --workspace @smartconnect/api-gateway

identity-test: ## Identity service unit tests (no database; its integration suites run in make db-test)
	npm run test --workspace @smartconnect/identity-service

identity-start: ## Build and start the identity service (http://127.0.0.1:3101, dev DB). Needs db-migrate, auth-dev-keys
	npm run build --workspace @smartconnect/identity-service
	@$(WITH_PRIVATE_JWK) npm run start --workspace @smartconnect/identity-service

organization-test: ## Organization service unit tests (integration suites run in make db-test)
	npm run test --workspace @smartconnect/organization-service

organization-start: ## Build and start the organization service (http://127.0.0.1:3102, dev DB). Creators: make organization-creators
	npm run build --workspace @smartconnect/organization-service
	@$(WITH_PUBLIC_JWKS) npm run start --workspace @smartconnect/organization-service

workspace-test: ## Workspace service unit tests (integration suites run in make db-test)
	npm run test --workspace @smartconnect/workspace-service

workspace-start: ## Build and start the workspace service (http://127.0.0.1:3103, dev DB)
	npm run build --workspace @smartconnect/workspace-service
	@$(WITH_PUBLIC_JWKS) npm run start --workspace @smartconnect/workspace-service

messaging-test: ## Messaging service unit tests (integration suites run in make db-test)
	npm run test --workspace @smartconnect/messaging-service

messaging-start: ## Build and start the messaging service (http://127.0.0.1:3104, dev DB)
	npm run build --workspace @smartconnect/messaging-service
	@$(WITH_PUBLIC_JWKS) npm run start --workspace @smartconnect/messaging-service

files-test: ## Files service unit tests (integration suites run in make db-test)
	npm run test --workspace @smartconnect/files-service

files-start: ## Build and start the files service (http://127.0.0.1:3106, dev DB, bytes in .local/files)
	npm run build --workspace @smartconnect/files-service
	@$(WITH_PUBLIC_JWKS) npm run start --workspace @smartconnect/files-service

realtime-test: ## Realtime gateway tests (in-process sockets; Redis/DB integration runs in make db-test)
	npm run test --workspace @smartconnect/realtime-gateway

realtime-start: ## Build and start the realtime gateway (ws://127.0.0.1:3105/realtime). Needs REDIS_URL in your shell
	npm run build --workspace @smartconnect/realtime-gateway
	@$(WITH_PUBLIC_JWKS) npm run start --workspace @smartconnect/realtime-gateway

backend-start: ## Build and start the UNIFIED backend: all seven apps in one process, public http://127.0.0.1:3000 (REST + /realtime/socket.io), internal apps on 127.0.0.1:3101-3106. Not together with the *-start targets above (same ports). Needs db-migrate, auth-dev-keys, infra-up
	npm run build --workspace @smartconnect/backend
	@$(WITH_PUBLIC_JWKS) $(WITH_PRIVATE_JWK) npm run start --workspace @smartconnect/backend

backend-test: ## Unified backend tests (environment views, ports, start/shutdown order, Socket.IO hand-off; no database)
	npm run test --workspace @smartconnect/backend

backend-kit-test: ## Shared backend kit tests (config helpers, access-token verification)
	npm run test --workspace @smartconnect/backend-kit

auth-dev-keys: ## Generate a local access-token key pair in .secrets/auth/ (gitignored); FORCE=1 replaces it
	node infrastructure/scripts/auth-dev-keys.mjs $(if $(FORCE),--force)

build: ## Build every workspace that defines a build script (run prisma-generate first)
	npm run build

audit: ## Fail on high/critical advisories in the dependency tree
	npm audit --audit-level=high

ci-local: format-check lint prisma-validate prisma-generate typecheck test-unit backend-kit-test gateway-test identity-test organization-test workspace-test messaging-test files-test realtime-test backend-test test-frontend build audit ## Run the CI quality gates locally (database + identity integration suites: make db-test)

# --- Infrastructure -----------------------------------------------------------------------------
infra-up: ## Start dev PostgreSQL + Redis and wait until healthy
	$(COMPOSE) up -d --wait postgres redis

infra-stop: ## Stop dev containers (data volumes are preserved)
	$(COMPOSE) stop postgres redis

infra-ps: ## Show container status and health
	$(COMPOSE) --profile test ps

test-db-up: ## Start the disposable test PostgreSQL (tmpfs, 127.0.0.1:15433)
	$(COMPOSE) --profile test up -d --wait postgres-test

test-db-reset: ## Recreate the disposable test PostgreSQL from scratch
	$(COMPOSE) --profile test rm -sf postgres-test
	$(MAKE) test-db-up

test-db-stop: ## Stop and remove the disposable test PostgreSQL (its data is discarded by design)
	$(COMPOSE) --profile test rm -sf postgres-test

# --- Prisma -------------------------------------------------------------------------------------
prisma-validate: ## Validate every service's schema.prisma
	npm run prisma:validate

prisma-generate: ## Generate every service's Prisma client
	npm run prisma:generate

# --- Database lifecycle (dev) -------------------------------------------------------------------
db-bootstrap: ## Apply schemas/roles/privileges and provision per-service credentials (idempotent)
	$(DB) bootstrap

db-rotate: ## Rotate credentials: make db-rotate SERVICE=<svc|all> [ROLE=app|migrator]
	$(DB) bootstrap --rotate=$(SERVICE) $(if $(ROLE),--role=$(ROLE))

db-migrate: ## Apply pending migrations for all services (prisma migrate deploy, as migrator roles)
	$(DB) migrate

db-status: ## Show migration status for all services
	$(DB) status

db-migration: ## Author a migration: make db-migration SERVICE=<svc> NAME=<snake_case> [EMPTY=1]
	$(DB) new-migration --service=$(SERVICE) --name=$(NAME) $(if $(EMPTY),--empty)

db-drift: ## Fail if any schema.prisma differs from its migrations (uses the test instance)
	$(DB) check-drift

db-rehearse: ## Rehearse bootstrap + all migrations on the test instance
	$(DB) rehearse

db-rehearse-managed: ## Rehearse the MANAGED (Render-like, no superuser) bootstrap on a disposable PostgreSQL 18 (127.0.0.1:15434; needs infra-up for Redis)
	node infrastructure/scripts/managed-rehearsal.mjs $(ARGS)

db-seed: ## Load idempotent demo data into the dev database (through each service's runtime role)
	npm run db:seed --workspace @smartconnect/backend-scripts

admin-seed: ## Create or reset the DEVELOPMENT Super Admin (admin@smartconnect.localhost; hidden password prompt; run it in your terminal)
	@bash infrastructure/scripts/admin-seed.sh

db-docs: ## Regenerate docs/database/erd.md and schema-reference.md from the dev database
	node infrastructure/scripts/db-docs.mjs

db-test: test-db-reset ## Database suites + identity/auth integration (needs infra-up for Redis) on a fresh test instance
	npm run test:db

e2e: build test-db-up ## Browser tests (Playwright, local Chrome) against the whole stack on ports 3300-3305, 3309 + 5174 and the test DB
	cd tests && npx playwright test --config e2e/playwright.config.ts $(ARGS)

e2e-unified: build test-db-up ## The same browser tests against the UNIFIED backend (one process: public 3300, internal 3301-3305, 3309) + 5174 and the test DB
	cd tests && E2E_BACKEND=unified npx playwright test --config e2e/playwright.config.ts $(ARGS)

load-30: build test-db-up ## 30 simultaneous users (5 orgs x 6: Chrome owners + API/Socket.IO members) on the unified backend + test DB; results in the log dir
	cd tests && E2E_BACKEND=unified npx playwright test --config load/playwright.config.ts $(ARGS)

organization-creators: ## Store who may create organizations (ORGANIZATION_CREATOR_EMAILS) in .secrets/organization.env; run it in your terminal
	@bash infrastructure/scripts/organization-creators.sh

smtp-credentials: ## Store the Gmail SMTP settings and App Password in .secrets/smtp.env (hidden input; run it in your own terminal)
	@bash infrastructure/scripts/smtp-credentials.sh

smtp-check: ## Check the SMTP connection and login from .secrets/smtp.env; sends nothing
	@npm run build --workspace @smartconnect/backend-kit >/dev/null
	@node infrastructure/scripts/smtp.mjs check

smtp-test-email: ## Send ONE test email: make smtp-test-email TO=someone@example.com
	@npm run build --workspace @smartconnect/backend-kit >/dev/null
	@node infrastructure/scripts/smtp.mjs send "$(TO)"

db-backup: ## Logical backup of the dev database into infrastructure/backup/output/ (gitignored)
	infrastructure/backup/backup.sh dev
