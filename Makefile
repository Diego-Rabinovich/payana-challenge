.PHONY: up down demo ingest reconcile report test lint check logs clean

## Bring up db + api + web
up:
	docker compose -f infra/docker-compose.yml up --build -d

down:
	docker compose -f infra/docker-compose.yml down

logs:
	docker compose -f infra/docker-compose.yml logs -f api

## Full run over fixtures. No credentials, no network.
## Writes data/out/report.md, report.json and movements.ndjson
demo:
	SOURCE_MODE=fixtures pnpm --filter @aa/cli demo

ingest:
	pnpm --filter @aa/cli dev ingest --source=$(SOURCE) --from=$(FROM) --to=$(TO)

reconcile:
	pnpm --filter @aa/cli dev reconcile --from=$(FROM) --to=$(TO)

report:
	pnpm --filter @aa/cli dev report --run=$(RUN) --format=all

test:
	pnpm -r test

lint:
	pnpm lint

## Must pass before a phase is called done
check: lint test
	pnpm typecheck

clean:
	rm -rf node_modules **/node_modules **/dist data/out/*
