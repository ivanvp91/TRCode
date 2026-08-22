---
name: sql-database
description: Design and work with databases — schema design, indexes for real query shapes, query optimization with EXPLAIN, N+1 elimination, reversible migrations, transactions and locking. Use for SQL queries, schema questions, slow queries, and database migrations.
description_ru: Проектирование и работа с базами данных — схема, индексы под реальные запросы, оптимизация запросов через EXPLAIN, устранение N+1, обратимые миграции, транзакции и блокировки. Для SQL-запросов, вопросов схемы, медленных запросов и миграций БД.
triggers: база данных, базу данных, database, sql, запрос sql, sql запрос, postgres, postgresql, mysql, sqlite, mongodb, схема данных, схема бд, миграция бд, миграции, индексы, index, orm, join, джойн, таблицы бд, explain, транзакция, transaction, deadlock, нормализация
---

# SQL and databases

## 1. Schema from the queries, not the nouns
List the top queries the app will actually run (reads AND writes, with rough frequency) before drawing tables — the schema serves them. Then:
- Normalize until it hurts, denormalize where a measured read path demands it — and mark every denormalization with how it stays in sync.
- Right types: numeric money as `DECIMAL` never float; timestamps with timezone discipline (store UTC); enums/checks for closed sets; no `VARCHAR(255)` cargo cult — size by the domain.
- Every table: a primary key, `created_at`, and foreign keys with explicit `ON DELETE` behavior chosen on purpose (cascade vs restrict vs set null — say why).
- Names: consistent convention matching the existing schema; singular/plural — copy what the project already does.

## 2. Indexes are for query shapes
- Index what appears in `WHERE`, `JOIN ... ON`, and `ORDER BY` of real queries; composite indexes ordered by selectivity and prefix use (an index on `(a,b)` serves `WHERE a` but not `WHERE b`).
- Foreign key columns get indexes — most engines don't do it automatically.
- Every index costs writes and space: don't index low-cardinality flags alone, don't duplicate prefixes, drop what `EXPLAIN` never uses.
- Uniqueness constraints live in the database (`UNIQUE`), not only in app code — races will find the gap.

## 3. Query work: EXPLAIN or it didn't happen
- Diagnose slow queries with `EXPLAIN` (ANALYZE where safe): look for full scans on big tables, missing index usage, row estimates wildly off (stale stats), sorts spilling.
- The N+1 pattern — a query per loop iteration — becomes one query with `JOIN`/`IN`/eager loading; it hides inside ORMs, so check the generated SQL, not the ORM code.
- Fetch what's needed: no `SELECT *` in hot paths, `LIMIT` on anything unbounded, pagination by keyset (`WHERE id > last`) not `OFFSET` for deep pages.
- Parameterized queries always — string-built SQL is an injection, security aside from performance.

## 4. Migrations: forward safely, backward possibly
- Every schema change is a migration file, ordered, in version control — no live hand-edits to production schemas.
- State reversibility per migration: the `down` path, or explicitly "irreversible, data-destroying" so the user decides.
- Danger moves on big/live tables — adding NOT NULL without default, type changes, index builds locking writes — get the safe recipe: add nullable → backfill in batches → add constraint; create index concurrently where the engine supports it.
- Deploy order when app and schema change together: expand (add new alongside old) → migrate code → contract (drop old) — never rename in one hop under a running app.

## 5. Transactions and concurrency
- A transaction wraps what must be atomic — and nothing more; long transactions holding locks across network calls are deadlock bait.
- Read-modify-write races (balances, counters, inventory): solve with atomic updates (`UPDATE ... SET x = x + 1`), row locks (`SELECT ... FOR UPDATE`), or optimistic versioning — pick one and name it.
- Retry on deadlock/serialization failures is normal; make the transaction idempotent so the retry is safe.

## What not to do
- No schema invented before seeing the queries; no float money; no app-level uniqueness "checks" instead of constraints.
- No `OFFSET 100000` pagination, no unparameterized SQL, no `SELECT *` in loops.
- No irreversible migration run without the user acknowledging what's destroyed; back up before destructive changes.
- Don't reach for a new database technology when an index would do.

## Answer format
For schema: the DDL with a line of rationale per non-obvious choice. For slow queries: EXPLAIN before → the change → EXPLAIN/timing after. For migrations: the migration file, its reversibility, and the deploy order if the app changes too.
