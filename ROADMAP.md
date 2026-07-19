# IndigoDB Roadmap

Gap analysis against mature ORMs (Sequelize, Prisma, TypeORM, Mongoose) and the
release plan toward a feature-complete version. Priorities were set with the
project owner: transactions, relations, migrations and advanced real-time all
matter — ordered below by dependency and cost.

**Status: all four priority areas are done as of v3.0.0.** The only open
items are the transversal tooling tasks at the bottom (dual ESM/CJS build,
CI, linting, generated docs) — none of them block the library being usable
end-to-end today.

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
| Mocked unit suite (no DB required) + opt-in integration suite | ✅ v2.0 |

## What's missing (the gaps)

- **Tooling**: ESM + CJS dual build, CI, linting, generated API docs. None of
  these block usage — see "Transversal" below.

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

### Transversal (parallel to any release)
- Dual ESM + CJS build (`exports` map in package.json).
- GitHub Actions CI: build + unit tests on every PR; integration suite against
  service containers.
- ESLint + Prettier; generated API docs (typedoc) published on releases.
