# IndigoDB Roadmap

Gap analysis against mature ORMs (Sequelize, Prisma, TypeORM, Mongoose) and the
release plan toward a feature-complete version. Priorities were set with the
project owner: transactions, relations, migrations and advanced real-time all
matter — ordered below by dependency and cost.

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
| Mocked unit suite (no DB required) + opt-in integration suite | ✅ v2.0 |

## What's missing (the gaps)

- **Relations**: `hasMany` / `belongsTo`, eager loading (`include` / populate).
- **Tooling**: ESM + CJS dual build, CI, linting, generated API docs.

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

### v3.0.0 — Relaciones
- Schema-level `references` (FKs in Postgres, ref validation in Mongo).
- `hasMany` / `belongsTo` model associations.
- Eager loading: `findAll(where, { include: ["posts"] })` — JOIN (or batched
  `$in`) on Postgres, `$lookup` (or batched find) on Mongo.

### Transversal (parallel to any release)
- Dual ESM + CJS build (`exports` map in package.json).
- GitHub Actions CI: build + unit tests on every PR; integration suite against
  service containers.
- ESLint + Prettier; generated API docs (typedoc) published on releases.
