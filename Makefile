.PHONY: up down logs demo run report test lint typecheck check clean

## Bring up db + api + web. Web on :8090, API on :3100, Postgres on :5433
up:
	docker compose -f infra/docker-compose.yml up --build -d

down:
	docker compose -f infra/docker-compose.yml down

logs:
	docker compose -f infra/docker-compose.yml logs -f api

## Start only the database, for running the CLI or tests against it
db:
	docker compose -f infra/docker-compose.yml up -d db

## Full pipeline over the configured period, then write the artifacts.
## Runs in the same image as the API, so it needs no toolchain on the host.
demo:
	docker compose -f infra/docker-compose.yml --profile tools run --rm cli demo --from=$(or $(FROM),2026-01-01) --to=$(or $(TO),2026-04-30)

run:
	docker compose -f infra/docker-compose.yml --profile tools run --rm cli run --from=$(FROM) --to=$(TO)

report:
	docker compose -f infra/docker-compose.yml --profile tools run --rm cli report

test:
	pnpm -r test

lint:
	pnpm lint

typecheck:
	pnpm -r typecheck

## What has to pass before a phase is called done
check: lint typecheck test

clean:
	rm -rf node_modules **/node_modules **/dist data/out/*
