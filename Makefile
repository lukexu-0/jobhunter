.DEFAULT_GOAL := help
CANONICAL_TMPDIR := $(shell cd "$${TMPDIR:-/tmp}" && pwd -P)

.PHONY: help install dev harness typecheck build test check test-e2e doctor production-restart production-restart-clean

help:
	@printf '%s\n' \
		'Jobhunt commands:' \
		'  make install                  Install exact backend, web, and harness dependencies' \
		'  make dev                      Start backend and web development services' \
		'  make harness                  Start the development browser harness' \
		'  make typecheck                Type-check backend, web, and harness' \
		'  make build                    Build backend, web, and harness' \
		'  make test                     Run misc, backend, web, and harness tests' \
		'  make check                    Run typecheck, build, and test' \
		'  make test-e2e                 Run web Playwright tests' \
		'  make doctor                   Diagnose backend system dependencies' \
		'  make production-restart       Guarded production rebuild and restart' \
		'  make production-restart-clean Guarded clean production rebuild and restart'

install:
	rm -rf apps/node_modules
	cd apps/backend && bun install --frozen-lockfile
	cd apps/web && bun install --frozen-lockfile
	cd apps/harness && bun install --frozen-lockfile
	cd apps/harness && bun run playwright:install-ffmpeg

dev:
	cd apps && bun ../misc/scripts/serve.ts dev

harness:
	bun run --cwd apps/harness dev -- --port 8865 --pipeline-url http://127.0.0.1:3557

typecheck:
	bun run --cwd apps/backend typecheck
	bun run --cwd apps/web typecheck
	bun run --cwd apps/harness typecheck

build:
	bun run --cwd apps/backend build
	bun run --cwd apps/web build
	bun run --cwd apps/harness build

test:
	TMPDIR="$(CANONICAL_TMPDIR)" bun test misc/scripts/launch-config.test.ts misc/scripts/user-context-backup.test.ts misc/scripts/restart-production.test.ts
	TMPDIR="$(CANONICAL_TMPDIR)" bun test --cwd apps/backend
	TMPDIR="$(CANONICAL_TMPDIR)" bun test --cwd apps/web
	TMPDIR="$(CANONICAL_TMPDIR)" bun test --cwd apps/harness

check: typecheck build test

test-e2e:
	bun run --cwd apps/web test:e2e

doctor:
	bun run --cwd apps/backend doctor

production-restart:
	cd apps && bun ../misc/scripts/restart-production.ts

production-restart-clean:
	cd apps && bun ../misc/scripts/restart-production.ts --clean
