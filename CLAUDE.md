# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

IndigoDB (`@adinet/indigodb`) is a lightweight TypeScript ORM for Node.js that works against **either** PostgreSQL or MongoDB, with real-time change notifications pushed to clients over a built-in WebSocket server. It's inspired by Firebase's real-time database behavior.

## Commands

- Build: `npm run build` (runs `tsc`, emits to `dist/`)
- Test: `npm test` (runs `jest` via `ts-jest`)
- Run a single test file: `npx jest tests/orm.test.ts`
- Run a single test by name: `npx jest -t "should initialize with PostgreSQL configuration"`

**Tests require live database instances.** `tests/orm.test.ts` and `tests/models/postgresModel.test.ts` connect to a real PostgreSQL database (`indigodb_test`, user `adinet`), and `tests/realtime.test.ts` additionally opens real WebSocket connections and listens for `pg_notify` events. There is no mocking layer — expect these tests to fail/hang without Postgres (and MongoDB, for Mongo-path tests) actually running and reachable.

## Architecture

The whole library is intentionally small and centers on one stateful `ORM` class (`src/orm.ts`) that owns all runtime state; there is no dependency injection or separate connection-pool abstraction.

- **`src/orm.ts`** — the `ORM` class (extends `EventEmitter`). `initialize(config)` connects to either Postgres (`pg.Client`) or MongoDB (`mongodb.MongoClient`) based on `config.databaseType`, then unconditionally starts a `ws` WebSocket server on `config.websocketPort` (default 8080). It also sets up a Postgres `LISTEN realtime_updates` subscription and exposes `broadcast(event, data)`, which fans out a JSON message to every connected WebSocket client. `defineModel<T>(name, schema)` dispatches to `definePostgresModel`/`defineMongoModel` depending on the active database type — a given `ORM` instance only ever talks to one database.
- **`src/models/postgresModel.ts`** — `PostgresModel<T>`. On construction it synchronously kicks off `init()`, which (a) issues `CREATE TABLE IF NOT EXISTS` from the model's `ModelSchema` and (b) creates a Postgres trigger + `plpgsql` function (`notify_<table>_change`) that calls `pg_notify('realtime_updates', ...)` on every INSERT/UPDATE/DELETE. This is how Postgres-backed models get real-time updates: DB trigger → `NOTIFY` → `ORM`'s Postgres listener → `broadcast()`. CRUD methods build raw parameterized SQL strings directly (no query builder). `findById`/`update`/`delete` all assume a `_id` column.
- **`src/models/mongoModel.ts`** — `MongoModel<T extends { _id: any }>`. Real-time updates instead use a native MongoDB **change stream** (`collection.watch(...)`) opened at construction time, whose events are forwarded through `orm.broadcast()`. This requires the target MongoDB deployment to be a replica set (per README). CRUD methods use the MongoDB driver directly; `_id` values are normalized to `ObjectId` when passed in as strings.
- **`src/dataTypes.ts`** — the `DataTypes` constant (`INTEGER`, `STRING`, `FLOAT`, `BOOLEAN`) used when defining a `ModelSchema`. Note: `PostgresModel.mapDataType` also accepts `DATE` and `TEXT`, which aren't in the exported `DataTypes` object — check this file when adding/using column types.
- **`src/types/index.ts`** — shared `ModelSchema` and `Config` interfaces used across the ORM and both model implementations.
- **`src/index.ts`** — the public package entrypoint. It creates a single module-level `ORM` instance and exports its `initialize`/`defineModel` methods as bound standalone functions, plus `DataTypes` and the `Config`/`ModelSchema` types. Consumers of the npm package only ever see this file's exports — the `ORM` class itself is not exported.

### Key implicit contracts to preserve

- Every model record (Postgres or Mongo) is expected to have an `_id` field/column; Postgres methods use `WHERE _id = ...` even though `createTable` doesn't auto-add an `_id` column — schemas passed to `defineModel` must define one explicitly.
- Real-time payloads broadcast over WebSocket have the shape `{ event: string, data: { model, operation, data } }` — keep this consistent between the Postgres trigger path and the Mongo change-stream path so frontend consumers can handle both uniformly.
- `ORM.initialize` always starts the WebSocket server, even if a caller only wants CRUD without real-time — there's no opt-out.
