# IndigoDB Roadmap

Gap analysis against mature ORMs (Sequelize, Prisma, TypeORM, Mongoose) and the
release plan toward a feature-complete version. Priorities were set with the
project owner: transactions, relations, migrations and advanced real-time all
matter — ordered below by dependency and cost.

**Status: all four priority areas are done as of v3.0.0**, and the data-type
gap flagged post-release was closed in v3.1.0. The only open item is the
dual ESM/CJS build — it doesn't block the library being usable end-to-end
today (Node ESM consumers already interop with the current CJS build).

## Where we are

| Area | Status |
| --- | --- |
| Dual backend (PostgreSQL / MongoDB) via adapters | ✅ v2.0 |
| Typed CRUD (`create`, `findAll`, `findById`, `update`, `delete`) | ✅ v2.0 |
| Real-time change events (opt-in WebSocket, triggers / change streams) | ✅ v2.0 |
| Safe identifiers (anti SQL-injection), typed errors, injectable logger | ✅ v2.0 |
| Explicit `connect()` / `close()` lifecycle | ✅ v2.0 |
| **Query engine**: operators (`$gt`, `$in`, `$like`, `$or`, ...), `orderBy` / `limit` / `offset` / `select`, `findOne` / `count` / `exists`, bulk ops (`createMany` / `updateMany` / `deleteMany`), `db.raw()` escape hatch | ✅ v2.1 |
| **Schema completeness**: `required`, `default` (value or factory), non-unique + unique indexes on both backends, `timestamps` model option | ✅ v2.2 |
| **Lifecycle hooks**: `beforeCreate`/`afterCreate`/`beforeUpdate`/`afterUpdate`/`beforeDelete`/`afterDelete` via `model.hooks` | ✅ v2.2 |
| **Transactions**: `db.transaction(async (tx) => ...)` with `tx.getModel()` (shares hooks with the original model), automatic commit/rollback on both backends | ✅ v2.3 |
| **Migrations**: `MigrationRunner` + `indigodb-migrate` CLI (`up`/`down`/`status`/`create`), history tracked via `defineModel` on both backends | ✅ v2.4 |
| **Advanced real-time**: filtered subscriptions (`{ type: "subscribe", models, where }`), pluggable `authenticate()`, dependency-free `@adinet/indigodb/client` | ✅ v2.5 |
| **Relations**: `hasMany` / `belongsTo`, eager loading via `include` (batched `$in`, not JOIN/`$lookup`), `references` FK hints | ✅ v3.0 |
| **Complete data types**: `BIGINT`, `DOUBLE`, `DECIMAL`, `UUID`, `ENUM`, `DATEONLY`, `BINARY` + `length`/`precision`/`scale`/`values` column options | ✅ v3.1 |
| Mocked unit suite (no DB required) + opt-in integration suite | ✅ v2.0 |

## What's missing (the gaps)

- **Dual ESM + CJS build** — deliberately deferred (owner's call): Node ESM
  consumers already interop cleanly with the current CJS build, and
  restructuring the build wasn't worth the breakage risk this close to a
  release. The only remaining transversal item.

## Release plan

### v2.2.0 — Schema completo + hooks ✅ Done
- `required` (NOT NULL), `default` values, `index: true` columns.
- Automatic `createdAt` / `updatedAt` timestamps (opt-in per model).
- Model hooks: `beforeCreate/afterCreate`, `beforeUpdate/afterUpdate`,
  `beforeDelete/afterDelete` registered on the model instance.

### v2.3.0 — Transacciones ✅ Done
- `db.transaction(async (tx) => { ... })` with automatic COMMIT/ROLLBACK.
- PostgreSQL: dedicated pool client with `BEGIN`; models run against the
  transaction client via the existing `QueryExecutor` seam.
- MongoDB: `ClientSession` + `withTransaction` (requires replica set — same
  constraint change streams already impose).

### v2.4.0 — Migraciones ✅ Done
- `indigodb-migrate` CLI: `create`, `up`, `down`, `status`.
- Migration history table/collection defined via the existing `defineModel()`
  (no backend-specific bookkeeping); migrations are plain JS files with
  `up`/`down` receiving a `MigrationContext.raw()` handle.
- Ordering uses an explicit monotonic `sequence` column, not `appliedAt`
  alone — avoids ties when several migrations apply within one DATE tick.

### v2.5.0 — Realtime avanzado ✅ Done
- Filtered subscriptions: clients send `{ type: "subscribe", models?, where? }`
  over the existing WebSocket connection; `matchesWhere()` evaluates the same
  operator syntax as the query engine in memory against each `ChangeEvent`.
- Pluggable `realtime.authenticate(request)` hook — refuse/close (code 4001)
  before the socket joins the broadcast pool.
- Frontend client: shipped as the `@adinet/indigodb/client` subpath export
  (via `package.json` `exports`) rather than a separate `@adinet/indigodb-client`
  package — same typed-events/auto-reconnect behavior, without a second
  package to publish and version in lockstep.

### v3.0.0 — Relaciones ✅ Done
- Schema-level `references: { model, column? }` — `REFERENCES` constraint on
  Postgres (target model must be defined first); documentation-only on Mongo.
- `model.hasMany(target, { foreignKey, as? })` / `model.belongsTo(target, { foreignKey, as? })`.
- Eager loading: `findAll(where, { include: ["posts"] })` — implemented as
  one batched `$in` query per association against the target model's own
  `findAll()`, not a native JOIN/`$lookup`. Simpler, identical on both
  backends, and avoids the row-multiplication JOINs cause with `hasMany`.

### v3.1.0 — Data types completos ✅ Done
- Seven new types: `BIGINT`, `DOUBLE`, `DECIMAL`, `UUID`, `ENUM`, `DATEONLY`,
  `BINARY` — 14 total, matching what Sequelize/Prisma-style ORMs commonly offer.
- Parameterized column options: `length` (STRING), `precision`/`scale`
  (DECIMAL), `values` (ENUM, required). Misconfiguration throws
  `ConfigurationError` at `defineModel()` time.
- ENUM values validated on create/update (+ bulk variants) on both backends;
  PostgreSQL additionally enforces it with a `CHECK` constraint.

### Transversal (parallel to any release) ✅ Done (except ESM)
- GitHub Actions CI ✅ — unit suite on Node 18/20/22 + integration suite
  against real Postgres 16 and Mongo 7 (single-node replica set) containers
  on every PR; typedoc docs built as a workflow artifact.
- ESLint (flat config, typescript-eslint) + Prettier ✅ — `npm run lint`.
- Generated API docs (typedoc) ✅ — `npm run docs`; published as CI artifact
  (GitHub Pages hosting left as an optional follow-up).
- Dual ESM + CJS build — **still deferred** (see "What's missing").
