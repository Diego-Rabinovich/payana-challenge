-- Append-only by construction.
--
-- Nothing here is ever updated in place except to re-record the same fact under
-- the same content-derived id, which is what makes re-ingesting a no-op. Runs
-- are not overwritten, they accumulate — that is what lets the system answer
-- "why did it say something different yesterday?".
--
-- Las relaciones son foreign keys declaradas, y cada una elige su comportamiento
-- al borrar en lugar de heredar el mismo:
--
--   · un reporte no existe sin su corrida, así que la sigue — CASCADE;
--   · un movimiento y un registro crudo sobreviven a la corrida que los trajo,
--     porque el ledger es acumulativo y `run_id` dice quién los vio primero, no
--     de quién son — SET NULL;
--   · un movimiento sin el registro del que salió no se puede auditar, y la
--     procedencia es la mitad del producto, así que borrar un crudo con
--     movimientos derivados se rechaza — RESTRICT.

create table if not exists runs (
  id               text primary key,
  started_at       timestamptz not null,
  finished_at      timestamptz,
  ruleset_version  text        not null,
  range_from       date        not null,
  range_to         date        not null,
  input_hashes     jsonb       not null default '{}'::jsonb
);

-- The fact, kept before it was interpreted: re-parsing after a parser fix
-- never has to go back to the source.
create table if not exists raw_records (
  id            text primary key,
  source_id     text        not null,
  origin        text        not null,
  fetched_at    timestamptz not null,
  content_hash  text        not null,
  payload       bytea       not null,
  run_id        text references runs (id) on delete set null
);

create index if not exists raw_records_source on raw_records (source_id, fetched_at desc);

-- The interpretation. The id is a hash of the content, so the upsert below is
-- what makes ingestion idempotent rather than a deduplication pass.
create table if not exists movements (
  id            text primary key,
  account_id    text        not null,
  external_id   text,
  occurred_at   timestamptz not null,
  value_date    date        not null,
  type          text        not null,
  amount_cents  bigint      not null,
  currency      text        not null,
  counterparty  text,
  description   text        not null,
  source_id     text        not null,
  raw_record_id text        not null references raw_records (id) on delete restrict,
  locator       text,
  metadata      jsonb       not null default '{}'::jsonb,
  run_id        text references runs (id) on delete set null
);

-- Ordering is part of the repository contract, so the index matches it.
create index if not exists movements_account_date on movements (account_id, value_date, id);
create index if not exists movements_external on movements (external_id) where external_id is not null;
-- Una FK sin índice del lado que apunta convierte cada borrado del otro lado en
-- un scan completo. Postgres indexa la clave primaria, nunca la foránea.
create index if not exists movements_raw_record on movements (raw_record_id);
create index if not exists movements_run on movements (run_id);
create index if not exists raw_records_run on raw_records (run_id);

-- Results, stored whole. A reconciliation is an immutable statement about a
-- period under a ruleset version; keeping the report rather than shredding it
-- into columns is what keeps an old answer reproducible after the rules change.
create table if not exists reconciliation_reports (
  run_id           text        not null references runs (id) on delete cascade,
  kind             text        not null,
  scope            text        not null,
  ruleset_version  text        not null,
  produced_at      timestamptz not null,
  report           jsonb       not null,
  primary key (run_id, kind, scope)
);
