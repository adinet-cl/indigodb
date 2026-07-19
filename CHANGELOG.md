# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-07-19

Relations — the last planned item on the roadmap to a feature-complete
release. Purely additive (no existing signature changes), but versioned as
3.0.0 to mark this as the feature-complete milestone.

### Added

- **`model.hasMany(target, { foreignKey, as? })`** / **`model.belongsTo(target, { foreignKey, as? })`**:
  register a one-to-many / many-to-one association between two models.
- **Eager loading**: `findAll(where, { include: ["posts"] })` /
  `findOne(where, { include: [...] })` attach the related record(s) under
  the association's `as` name. Implemented as **one batched `$in` query per
  association** (not a JOIN/`$lookup`) by calling the target model's own
  `findAll()` — works identically on both backends with zero backend-specific
  code, and sidesteps the row-multiplication problem plain SQL JOINs have
  with `hasMany`. `include` on an unregistered association throws
  `ConfigurationError`.
- **`ColumnDefinition.references`**: `{ model, column? }`. PostgreSQL adds a
  `REFERENCES` constraint (the referenced table must already exist — define
  target models first); MongoDB treats it as documentation only, since it
  has no native FK constraints.

## [2.5.0] - 2026-07-19

Advanced real-time. Fully backward compatible with v2.4 — clients that never
send a "subscribe" message keep receiving every change event, as before.

### Added

- **Filtered subscriptions**: a client can send
  `{ "type": "subscribe", "models": [...], "where": {...} }` over the
  WebSocket connection to receive only matching `ChangeEvent`s. A later
  "subscribe" message replaces the previous filter. `where` uses the same
  operator syntax as the query engine (`$gt`, `$in`, `$like`, `$or`, ...),
  evaluated in memory against the event payload (new `matchesWhere()`
  helper) — no database round-trip.
- **Pluggable WebSocket auth**: `realtime.authenticate(request)` runs for
  every incoming connection with the raw HTTP upgrade request; returning
  (or resolving) `false` — or throwing — closes the socket with code 4001
  before it's added to the client pool.
- **`@adinet/indigodb/client`**: a small, dependency-free `RealtimeClient`
  for browsers (or any runtime with a global `WebSocket`) — connects, sends
  the subscribe filter, re-subscribes after reconnecting, and backs off
  exponentially between reconnect attempts. Exported via a new `exports`
  map subpath so it never pulls in `pg`/`mongodb`/`ws`/Node built-ins.

### Changed

- `RealtimeConfig` gains `authenticate`; `WebSocketGateway`'s constructor
  gains a third `authenticate` parameter (both optional, non-breaking).

## [2.4.0] - 2026-07-19

Migrations. Fully backward compatible with v2.3.

### Added

- **`MigrationRunner`** (exported): applies/reverts migrations from a
  directory of `.js`/`.cjs` files (loaded and ordered by filename), tracked
  in a history table/collection defined via the existing `defineModel()` —
  no backend-specific bookkeeping code, works identically on both backends.
  - `up()` — applies every pending migration, in filename order.
  - `down()` — reverts the most recently applied migration.
  - `status()` — `{ applied, pending }` migration names.
  - History records use an explicit monotonic `sequence` column (not just
    `appliedAt`) so `down()` picks the right migration even when several are
    applied within the same DATE-column tick.
- **`indigodb-migrate` CLI** (new `bin` entry): `up`, `down`, `status`,
  `create <name>` (scaffolds a migration file). Reads `indigodb.config.js`
  (or `--config <path>`) from the working directory —
  `module.exports = { database: {...}, migrationsDir: "./migrations" }`.
- Migration files receive a `MigrationContext` with `raw()` — the same
  escape hatch as `IndigoDB.raw()` — so `up`/`down` run real SQL on
  PostgreSQL or command documents on MongoDB.
- New exported types: `Migration`, `MigrationContext`, `MigrationStatus`,
  `MigrationDatabase`, `MigrationRunnerOptions`.

## [2.3.0] - 2026-07-19

Transactions. Fully backward compatible with v2.2.

### Added

- **`db.transaction(async (tx) => { ... })`**: commits on success, rolls back
  and rethrows if the callback throws.
  - PostgreSQL: a dedicated pooled connection running `BEGIN` / `COMMIT` /
    `ROLLBACK`; the connection is always released back to the pool.
  - MongoDB: a `ClientSession` driven by `withTransaction` (requires a
    replica set, same constraint as change streams); the session is always
    ended.
- **`tx.getModel(model)`**: exchanges an already-`defineModel`'d instance for
  a clone bound to the transaction — same schema, primary key and (crucially)
  the **same `hooks` registry** as the original, so hooks registered before
  entering the transaction still fire for operations run through it. Queries
  made via the clone participate in the transaction; the original model
  handle is unaffected and keeps working outside of it.
- New `TransactionContext` type (exported).

## [2.2.0] - 2026-07-19

Schema completeness + lifecycle hooks. Fully backward compatible with v2.1.

### Added

- **`ColumnDefinition`**: `required` (NOT NULL on Postgres, validated on both
  backends), `default` (static value or a zero-arg factory function, applied
  when the column is omitted on `create()`/`createMany()`), `index` (creates
  a non-unique index; `unique` now also creates a unique index on MongoDB,
  where it previously had no effect).
- **`ModelOptions.timestamps`**: opt-in per model via
  `defineModel(name, schema, { timestamps: true })`. Adds managed
  `createdAt`/`updatedAt` columns — stamped on `create()`, refreshed on
  `update()`/`updateMany()`.
- **Lifecycle hooks** via `model.hooks`: `beforeCreate`, `afterCreate`,
  `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. `before*`
  hooks may return a partial payload to merge into the pending data. Hooks
  run for single-row `create()`/`update()`/`delete()` only — bulk operations
  (`createMany`/`updateMany`/`deleteMany`) skip them by default (same
  convention as Sequelize) so a bulk call doesn't silently re-fetch every
  affected row.
- `ValidationError` for missing `required` columns; exported hook types
  (`BeforeCreateHook`, `AfterCreateHook`, ...) and `ModelOptions`.

## [2.1.0] - 2026-07-19

Query engine release. Fully backward compatible with v2.0 — plain equality
filters keep working unchanged.

### Added

- **Filter operators** on both backends: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`,
  `$lte`, `$in`, `$nin`, `$like`, `$null`, and `$or` / `$and` combinators.
  Compiled to parameterized SQL on PostgreSQL, passed natively to MongoDB
  (`$like` becomes an escaped, anchored regex).
- **Query options** on `findAll` / `findOne`: `orderBy`, `limit`, `offset`,
  `select` (projection).
- **New model methods**: `findOne`, `count`, `exists`, `createMany`
  (single multi-row INSERT on PG), `updateMany`, `deleteMany`.
- **`db.raw()` escape hatch**: parameterized SQL on PostgreSQL, command
  documents on MongoDB.
- `QueryError` error class; `Where`, `FieldOperators`, `QueryOptions`,
  `OrderDirection` exported types.
- `ROADMAP.md` with the gap analysis and release plan toward v3.0.

### Security

- Every column referenced in a filter tree (including inside `$or`/`$and`),
  `orderBy`, and `select` is validated against the model schema before
  compiling; `limit`/`offset` must be non-negative integers; `$like` patterns
  are regex-escaped on MongoDB.

## [2.0.0] - 2026-07-19

Full rewrite around a pluggable adapter architecture. This release contains
breaking API changes.

### Breaking

- Replaced the hidden module-level singleton (`initialize` / `defineModel`
  bound functions) with an exported `IndigoDB` class: `new IndigoDB(config)`.
- Configuration is now nested and discriminated: `{ database: { type, ... },
  realtime?, logger? }` instead of a flat object with `databaseType`.
- `defineModel<T>()` is now **async** and returns a typed `Model<T>` instead of
  `any`; always `await` it.
- The WebSocket server is now **opt-in** via `realtime: { enabled: true }`.
- PostgreSQL primary keys are taken from the `primaryKey: true` column in the
  schema instead of a hardcoded `_id` column.

### Added

- `IndigoDB.connect()` and `IndigoDB.close()` for an explicit lifecycle that
  releases the connection pool, LISTEN client, change streams, and WebSocket
  server (fixes the hanging test process).
- Adapter architecture: `DatabaseAdapter` with `PostgresAdapter` and
  `MongoAdapter`; `BaseModel<T>` Template Method; `RealtimeGateway` Strategy
  with `WebSocketGateway`.
- Identifier validation for table and column names (SQL-injection guard) plus
  unknown-column rejection in CRUD payloads/criteria.
- Typed error hierarchy: `IndigoDBError`, `ConfigurationError`,
  `ConnectionError`, `UnsupportedTypeError`, `InvalidIdentifierError`,
  `UnknownColumnError`.
- Injectable `Logger` (`noopLogger` default, `consoleLogger` provided).
- `DATE`, `TEXT`, and `JSON` data types (`JSON` maps to `JSONB` in Postgres).
- Fully mocked unit test suite that runs without any database, plus an opt-in
  integration suite gated by `INDIGODB_INTEGRATION=1`.
- WebSocket heartbeat (ping/pong) and error handling on the gateway.

### Fixed

- MongoDB `update`/`replace` operations are now broadcast as `UPDATE` events
  (previously dropped).
- PostgreSQL models no longer run CRUD before their table/triggers exist
  (`defineModel` awaits initialization).
- Malformed `pg_notify` payloads and connection errors are handled instead of
  crashing the process.
- `ws` moved from `devDependencies` to `dependencies` so the published package
  works when installed.
- SQL identifiers (table/column names) are now double-quoted, so reserved words
  (`user`, `order`, `end`, ...) and case-sensitive names are valid.
- MongoDB `BOOLEAN` coercion no longer turns the strings `"false"`/`"0"` into
  `true`.
- MongoDB `create()` re-reads the inserted document by its `_id` instead of the
  declared primary key, so a custom primary key no longer returns `null`.
- Redefining a MongoDB model reuses the existing handle instead of opening a
  second change stream (which double-broadcast every change).
- `connect()` rolls back the database connection if the WebSocket gateway fails
  to start, and the Postgres listener reconnect no longer leaks the previous
  client.

### Removed

- Unused `mongoose`, `events`, and `@types/mongodb` dependencies; `dotenv`
  moved to `devDependencies`.

## [1.0.2]

- Initial published versions (proof of concept).
