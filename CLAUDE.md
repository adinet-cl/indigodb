# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

IndigoDB (`@adinet/indigodb`) is a lightweight TypeScript ORM for Node.js that works against **either** PostgreSQL or MongoDB, with real-time change notifications pushed to clients over a built-in (opt-in) WebSocket server. It's inspired by Firebase's real-time database behavior. As of v2 it is built around a pluggable adapter architecture.

## Commands

- Build: `npm run build` (runs `tsc -p tsconfig.build.json`, emits JS + `.d.ts` + sourcemaps to `dist/`)
- Test: `npm test` (Jest via ts-jest) — the default suite is **fully mocked and needs no database**
- Run a single test file: `npx jest tests/unit/postgresModel.test.ts`
- Run a single test by name: `npx jest -t "create builds a parameterized INSERT"`
- Integration tests (opt-in, need live DBs): `npm run test:integration` — reads connection details from `.env` (see `.env.example`) and is gated by `INDIGODB_INTEGRATION=1`

`jest.config.js` excludes `tests/integration/` from the default run unless `INDIGODB_INTEGRATION` is set, so `npm test` never hangs waiting on a database.

## Architecture

The library composes small pieces via a few classic patterns. The public entrypoint (`src/index.ts`) exports the `IndigoDB` class plus `DataTypes`, the error hierarchy, `Logger`, and the public types — there is no singleton.

- **`src/indigodb.ts`** — the `IndigoDB` facade (extends `EventEmitter`). The constructor picks a `DatabaseAdapter` from `config.database.type` and, only if `config.realtime?.enabled`, creates a `WebSocketGateway`. It wires `adapter.on("change") → this.emit("change") → gateway.broadcast("databaseUpdate", event)`. `connect()` starts adapter then gateway; `defineModel<T>()` delegates to the adapter (and requires `connect()` first); `transaction<R>()` delegates to `adapter.transaction()`; `close()` tears everything down.
- **`src/adapters/adapter.ts`** — abstract `DatabaseAdapter extends EventEmitter` (Adapter + Factory Method). Contract: `connect()`, `disconnect()`, `defineModel<T>()`, `raw()`, `transaction<R>()`, and `emitChange()` which fires a uniform `ChangeEvent`. `TransactionContext` (`{ getModel<T>(model) }`) is the shared shape both backends' `transaction()` hand to the callback.
- **`src/adapters/postgres/`** — `PostgresAdapter` uses a `pg.Pool` for queries and a **separate** dedicated `pg.Client` for the `LISTEN indigodb_changes` subscription (with error handling + reconnect backoff). `PostgresModel` (`extends BaseModel`) runs `CREATE TABLE` + a per-table trigger/`plpgsql` function that `pg_notify`s on every INSERT/UPDATE/DELETE. `defineModel` **awaits** `model.init()` before returning, so CRUD never races table creation. The notification channel name lives in `constants.ts`. `PostgresAdapter.transaction()` checks out a pooled client, runs `BEGIN`/`COMMIT`/`ROLLBACK` around the callback, and always `release()`s it; `PostgresModel.withClient()` returns a clone bound to that client (same schema, same `hooks` instance) for `tx.getModel()`.
- **`src/adapters/mongo/`** — `MongoAdapter` opens a `collection.watch()` change stream per model (tracked so `disconnect()` can close them) and maps `insert`/`update`/`replace`/`delete` to `ChangeEvent`s. Requires a replica set. `MongoModel` (`extends BaseModel`) uses the driver directly; `_id` strings that are valid ObjectIds are converted. `MongoAdapter.transaction()` opens a `ClientSession` and drives it with `withTransaction()` (always `endSession()`s in a `finally`); `MongoModel.withSession()` returns a clone (same collection, schema, `hooks`) whose private `session` field is merged into every driver call via `withOptions()` — that's the seam `tx.getModel()` uses.
- **`src/models/baseModel.ts`** — abstract `BaseModel<T>` (Template Method). Validates the table name and every column name via `assertValidIdentifier`, resolves the primary key (from `primaryKey: true`, or a backend default like Mongo's `_id`), and offers `assertKnownColumns()` / `assertKnownWhereColumns()` / `assertKnownOptionColumns()` to reject columns outside the schema. When `options.timestamps` is set, merges `createdAt`/`updatedAt` DATE columns into `this.schema` at construction time (so table creation, indexing and query validation all see them automatically). Exposes `applyDefaults()`, `assertRequiredColumns()`, `prepareForCreate()`/`prepareForUpdate()` (defaults + timestamp stamping + required validation — call these from each backend's `create`/`update`, but NOT from the bulk variants' hook step) and the public `hooks: HookRegistry<T>` instance. Declares the abstract CRUD + query signatures (`findOne`, `count`, `exists`, `createMany`, `updateMany`, `deleteMany`). The constructor takes an optional `sharedHooks` param (5th arg) so a transaction-bound clone can reuse the original model's `HookRegistry` instead of getting a fresh, empty one.
- **`src/models/hooks.ts`** — `HookRegistry<T>`: `beforeCreate`/`afterCreate`/`beforeUpdate`/`afterUpdate`/`beforeDelete`/`afterDelete` registration + `runX()` execution helpers. `before*` hooks may return a partial payload merged into the pending data. **Only single-row `create()`/`update()`/`delete()` run hooks** — `createMany`/`updateMany`/`deleteMany` intentionally skip them (matches Sequelize's default) to avoid an implicit per-row re-fetch on bulk paths. Preserve this asymmetry when touching bulk methods.
- **`src/query/where.ts`** — the shared query-engine layer: `Where<T>` / `FieldOperators` / `QueryOptions<T>` types, `isOperatorObject()` (rejects unknown/mixed `$ops`), `walkWhere()` (recursive column-name walker used for validation), `assertNonNegativeInteger()`. Backend-specific compilation lives in `src/adapters/postgres/whereCompiler.ts` (Where → parameterized SQL: `$in` → `= ANY($n)`, `$null` → `IS NULL`, parenthesized `$or`/`$and`) and `src/adapters/mongo/filterCompiler.ts` (Where → native filter; `$like` → escaped anchored regex via `likeToRegex`). Both compilers assume column names were validated by the model first — never call them with unvalidated field names.
- **`src/realtime/`** — `RealtimeGateway` interface (Strategy) + `WebSocketGateway` (ws server with ping/pong heartbeat and clean `stop()`). Real-time is entirely optional.
- **`src/migrations/migrationRunner.ts`** — `MigrationRunner` applies/reverts migration files (`.js`/`.cjs`, loaded via `require()` and ordered by filename) from a directory. History is tracked in a table/collection defined through the model's own `defineModel()` (schema: `name` primary key, `appliedAt`, and a monotonic `sequence` int) — reuses the whole CRUD/schema stack instead of hand-rolled backend-specific bookkeeping SQL/commands. `down()` orders by `sequence`, not `appliedAt`, because DATE-column resolution can tie when several migrations apply in one `up()` run. Depends only on the minimal `MigrationDatabase` interface (`defineModel` + `raw`), not the concrete `IndigoDB` class, so it's trivially mockable in tests.
- **`src/cli/migrate.ts`** — the `indigodb-migrate` bin (`up`/`down`/`status`/`create`). Reads `indigodb.config.js` (or `--config <path>`) from the CWD via `require()`. `runCli(argv, log?)` is exported separately from the `require.main === module` guard specifically so tests can exercise command dispatch without spawning a subprocess.
- **`src/identifiers.ts`** — `assertValidIdentifier()` (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`, ≤63 chars); the SQL-injection guard for interpolated identifiers.
- **`src/dataTypes.ts`** — `DataTypes` (`INTEGER`, `STRING`, `FLOAT`, `BOOLEAN`, `DATE`, `TEXT`, `JSON`) and `POSTGRES_TYPE_MAP` (`JSON → JSONB`).
- **`src/errors.ts`** — `IndigoDBError` base + typed subclasses. **`src/logger.ts`** — `Logger` interface, `noopLogger` (default), `consoleLogger`. **`src/types.ts`** — `Config`, `DatabaseConfig` (discriminated union), `ModelSchema`, `ColumnDefinition`, `ChangeEvent`.

### Key implicit contracts to preserve

- **Uniform change payload:** both the Postgres trigger path and the Mongo change-stream path must produce `ChangeEvent = { model, operation: "INSERT" | "UPDATE" | "DELETE", data }`. Over WebSocket it is wrapped as `{ event: "databaseUpdate", data: ChangeEvent }` — keep this stable for frontend consumers.
- **Identifiers are only ever interpolated after `assertValidIdentifier`;** values always go through parameterized queries / driver filters. Never build SQL by concatenating unvalidated names or values. Filter trees are validated with `assertKnownWhereColumns` (which walks `$or`/`$and`) before hitting a compiler; `limit`/`offset` are integer-checked.
- **`defineModel` is async** and must complete backend setup (table + triggers for Postgres) before the returned model is usable.
- **`close()` must release every resource** (pool, LISTEN client, change streams, WS server) — this is what keeps the test process from hanging.
- Adapters are the only place that knows a specific backend; `IndigoDB` must stay backend-agnostic (no `if (type === ...)` in CRUD paths).

### Adding a new backend

Implement a `DatabaseAdapter` subclass and a `BaseModel<T>` subclass, then add a branch in `createAdapter()` in `src/indigodb.ts`. Nothing else in the facade should need to change.
