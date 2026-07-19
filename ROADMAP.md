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
| Mocked unit suite (no DB required) + opt-in integration suite | ✅ v2.0 |

## What's missing (the gaps)

- **Transactions**: atomic multi-operation units with rollback.
- **Migrations**: `CREATE TABLE IF NOT EXISTS` never alters existing tables —
  schema evolution is manual today.
- **Advanced real-time**: per-model/filtered subscriptions, WebSocket
  authentication, a frontend client library.
- **Relations**: `hasMany` / `belongsTo`, eager loading (`include` / populate).
- **Tooling**: ESM + CJS dual build, CI, linting, generated API docs.

## Release plan

### v2.2.0 — Schema completo + hooks ✅ Done
- `required` (NOT NULL), `default` values, `index: true` columns.
- Automatic `createdAt` / `updatedAt` timestamps (opt-in per model).
- Model hooks: `beforeCreate/afterCreate`, `beforeUpdate/afterUpdate`,
  `beforeDelete/afterDelete` registered on the model instance.

### v2.3.0 — Transacciones
- `db.transaction(async (tx) => { ... })` with automatic COMMIT/ROLLBACK.
- PostgreSQL: dedicated pool client with `BEGIN`; models run against the
  transaction client via the existing `QueryExecutor` seam.
- MongoDB: `ClientSession` + `withTransaction` (requires replica set — same
  constraint change streams already impose).

### v2.4.0 — Migraciones
- `indigodb migrate` CLI: `create`, `up`, `down`, `status`.
- Migration history table/collection; migrations written in TS with `up`/`down`
  receiving the adapter's raw handle.
- Schema diffing helper to generate an initial migration from `defineModel`
  schemas.

### v2.5.0 — Realtime avanzado
- Filtered subscriptions: clients subscribe to specific models/criteria over
  the WebSocket protocol instead of receiving every change.
- Pluggable WebSocket auth hook (token validation on connection).
- Lightweight frontend client package (`@adinet/indigodb-client`) with typed
  events and auto-reconnect.

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
