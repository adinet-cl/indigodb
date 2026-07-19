# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
