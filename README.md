# IndigoDB

[![CI](https://github.com/Adinet-CL/indigodb/actions/workflows/ci.yml/badge.svg)](https://github.com/Adinet-CL/indigodb/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40adinet%2Findigodb)](https://www.npmjs.com/package/@adinet/indigodb)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

IndigoDB is a lightweight ORM for Node.js that works against **either PostgreSQL or MongoDB**, with real-time change notifications pushed to clients over a built-in WebSocket server. It's inspired by Firebase's real-time database behavior: define a model, run CRUD, and connected clients are notified of every insert/update/delete automatically.

> **v2+ is a full rewrite** with a new instance-based API, opt-in real-time, typed models, and a pluggable adapter architecture. See the [Migration guide](#migration-from-v1) if you are upgrading from v1.

## Features

- **Dual database support** — one API over PostgreSQL and MongoDB, swapped by config.
- **Rich query engine** — Mongo-style operators (`$gt`, `$in`, `$like`, `$or`, ...), pagination, projection, bulk operations, and a `raw()` escape hatch.
- **Relations** — `hasMany` / `belongsTo` with batched eager loading via `include`.
- **Transactions** — `db.transaction()` with automatic commit/rollback on both backends.
- **Migrations** — `indigodb-migrate` CLI + programmatic `MigrationRunner`.
- **Real-time updates (opt-in)** — Postgres triggers + `LISTEN/NOTIFY` and MongoDB change streams are fanned out to WebSocket clients, with filtered subscriptions, pluggable auth, and a dependency-free frontend client.
- **Schema features** — `required`, `default`, indexes, automatic timestamps, lifecycle hooks.
- **Fully typed** — `defineModel<T>()` returns a typed `Model<T>`; no `any` leaking into your code.
- **Safe by default** — table/column identifiers are validated (anti SQL-injection) and all values are parameterized.
- **Explicit lifecycle** — `connect()` / `close()` cleanly open and release every resource (pool, listener, change streams, WebSocket server).
- **Injectable logger** — the library is silent unless you pass a `Logger`.
- **Production-hardened real-time** — per-column redaction, opt-out per model, an oversized-row guard that can't abort your writes, and MongoDB change-stream auto-resume.

## Installation

```bash
npm install @adinet/indigodb
```

`pg`, `mongodb`, and `ws` are regular runtime dependencies — no extra peer installs required.

## Quick start

```typescript
import { IndigoDB, DataTypes } from "@adinet/indigodb";

interface User {
  id: number;
  name: string;
  email: string;
}

const db = new IndigoDB({
  database: {
    type: "postgresql",
    host: "localhost",
    port: 5432,
    user: "db_user",
    password: "db_password",
    database: "db_name",
  },
  realtime: { enabled: true, port: 8080 }, // omit to skip the WebSocket server
});

await db.connect();

const Users = await db.defineModel<User>("users", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING },
  email: { type: DataTypes.STRING, unique: true },
});

const user = await Users.create({ name: "John Doe", email: "john@example.com" });
const all = await Users.findAll();
const byId = await Users.findById(user.id);
await Users.update(user.id, { name: "Jane Doe" });
await Users.delete(user.id);

// In-process subscription to every change (works even without WebSockets):
db.on("change", (event) => {
  console.log(event); // { model, operation: "INSERT" | "UPDATE" | "DELETE", data }
});

await db.close(); // releases the pool, listener, change streams and WS server
```

### MongoDB

```typescript
const db = new IndigoDB({
  database: {
    type: "mongodb",
    connectionString: "mongodb://localhost:27017/mydb",
  },
  realtime: { enabled: true, port: 8080 },
});
```

MongoDB documents use `_id` as the primary key automatically; string ids that look like an `ObjectId` are converted for you. Change streams require the MongoDB deployment to be a **replica set**.

## Real-time frontend integration

### Plain WebSocket

Connect to the WebSocket server and listen for updates:

```typescript
const socket = new WebSocket("ws://localhost:8080");

socket.onmessage = (event) => {
  const { event: name, data } = JSON.parse(event.data);
  // name === "databaseUpdate"
  // data === { model, operation, data }
  console.log("Real-time update:", data);
};
```

The payload shape is identical whether the change originated in PostgreSQL or MongoDB, so a single frontend handler covers both backends. By default a client receives **every** change event across every model.

### Filtered subscriptions

Send a `subscribe` message right after connecting to narrow what you receive — by model, by a `Where` filter (same operator syntax as [Querying](#querying)), or both. A later `subscribe` message replaces the previous filter:

```typescript
socket.onopen = () => {
  socket.send(JSON.stringify({
    type: "subscribe",
    models: ["orders"],
    where: { status: "urgent" },
  }));
};
```

### `@adinet/indigodb/client`

A small, dependency-free client (works in any environment with a global `WebSocket` — browsers, or Node 22+) handles connecting, sending the subscribe filter, re-subscribing after a reconnect, and exponential backoff:

```typescript
import { RealtimeClient } from "@adinet/indigodb/client";

const client = new RealtimeClient({
  url: "ws://localhost:8080",
  models: ["orders"],
  where: { status: "urgent" },
});
client.connect();

const unsubscribe = client.on((event) => {
  console.log(event.model, event.operation, event.data);
});
```

### WebSocket authentication

Pass `realtime.authenticate` to validate connections (token in a header, query string, cookie — whatever your app uses) before they're accepted; refusing a connection closes the socket with code `4001`:

```typescript
const db = new IndigoDB({
  database: { /* ... */ },
  realtime: {
    enabled: true,
    authenticate: (request) => {
      const token = new URL(request.url ?? "", "http://x").searchParams.get("token");
      return token === process.env.REALTIME_TOKEN;
    },
  },
});
```

## API reference

### `new IndigoDB(config)`

| Config field | Description |
| --- | --- |
| `database` | Discriminated by `type`. PostgreSQL: `{ type: "postgresql", host, port, user, password, database, ssl?, pool? }` (or `connectionString`). MongoDB: `{ type: "mongodb", connectionString, database?, options? }`. See [Production hardening](#production-hardening) for `ssl`/`pool`/`options`. |
| `realtime` | Optional. `{ enabled: boolean, port?: number, authenticate? }` — defaults to port `8080`. When omitted or `enabled: false`, **no WebSocket server is started**. `authenticate(request)` (optional) runs per connection; return `false` to refuse it. |
| `logger` | Optional `Logger`. Defaults to a no-op; pass `consoleLogger` (exported) or your own. |

### Methods

- **`connect(): Promise<void>`** — connects the adapter (fails fast on bad credentials) and starts the WebSocket server if real-time is enabled.
- **`defineModel<T>(name, schema, options?): Promise<Model<T>>`** — creates the table/collection (indexes, Postgres triggers) and resolves once it is ready. **Async** — always `await` it. `options.timestamps: true` adds managed `createdAt`/`updatedAt` columns; `options.broadcast`/`options.redact` control real-time — see [Production hardening](#production-hardening).
- **`on("change", listener)`** — subscribe to `ChangeEvent`s in-process (inherited from `EventEmitter`).
- **`transaction<R>(fn): Promise<R>`** — see [Transactions](#transactions).
- **`close(): Promise<void>`** — stops the WebSocket server, closes change streams, and drains the connection pool / client.

### Model methods

| Method | Description |
| --- | --- |
| `create(data)` | Insert a record; returns the created row. |
| `createMany(data[])` | Bulk insert (single multi-row INSERT / `insertMany`); returns the created rows. |
| `findAll(where?, options?)` | Query with operators, `orderBy`, `limit`, `offset`, `select`, `include` (see [Relations](#relations)). |
| `findOne(where?, options?)` | First match or `null`. |
| `findById(id)` | Return a record by its primary key, or `null`. |
| `count(where?)` | Number of matching records. |
| `exists(where?)` | `true` if at least one record matches. |
| `update(id, data)` | Update by primary key; returns the updated row or `null`. |
| `updateMany(where, data)` | Bulk update; returns the number of affected records. |
| `delete(id)` | Delete by primary key; returns the deleted row or `null`. |
| `deleteMany(where)` | Bulk delete; returns the number of removed records. |

The primary key is taken from the column marked `primaryKey: true` in the schema (PostgreSQL), or defaults to `_id` (MongoDB).

## Schema features

Beyond `type` / `primaryKey` / `autoIncrement` / `unique`, columns support:

```typescript
const Accounts = await db.defineModel<Account>(
  "accounts",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING, required: true, unique: true },
    plan: { type: DataTypes.STRING, default: "free" }, // static value...
    apiKey: { type: DataTypes.STRING, default: () => crypto.randomUUID() }, // ...or a factory
    status: { type: DataTypes.STRING, index: true }, // non-unique index
  },
  { timestamps: true } // adds managed createdAt / updatedAt columns
);
```

- **`required`** — rejects `create()`/`createMany()` calls missing the column (after defaults are applied) with a `ValidationError`.
- **`default`** — a static value or a zero-argument factory invoked per row when the column is omitted.
- **`index`** — creates a non-unique index; `unique` (already available) creates a unique index on both backends.
- **`timestamps`** (model option) — `createdAt` is stamped on `create()`; `updatedAt` is stamped on `create()` and refreshed on every `update()` / `updateMany()`.
- **`references`** — `{ model, column? }`, a foreign key hint (see [Relations](#relations)).

## Relations

```typescript
const Users = await db.defineModel<User>("users", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING },
});

// Define the target of a reference BEFORE the model that references it —
// PostgreSQL needs the referenced table to already exist.
const Posts = await db.defineModel<Post>("posts", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  title: { type: DataTypes.STRING },
  userId: { type: DataTypes.INTEGER, references: { model: "users" } },
});

Users.hasMany(Posts, { foreignKey: "userId", as: "posts" });
Posts.belongsTo(Users, { foreignKey: "userId", as: "author" });

const usersWithPosts = await Users.findAll({}, { include: ["posts"] });
console.log(usersWithPosts[0].posts); // Post[]

const postsWithAuthor = await Posts.findAll({}, { include: ["author"] });
console.log(postsWithAuthor[0].author); // User | null
```

- **`references`** (PostgreSQL) adds a `REFERENCES` constraint at table-creation time. On MongoDB it's documentation only — there's no native FK enforcement.
- **`include`** runs **one batched query per association** (via `$in` against the target model, reusing its own `findAll()`) — never one query per row, and identical on both backends since no JOIN/`$lookup` is involved. Including an association that wasn't registered with `hasMany`/`belongsTo` throws `ConfigurationError`.

## Lifecycle hooks

```typescript
Accounts.hooks.beforeCreate((data) => ({ email: (data.email as string).toLowerCase() }));
Accounts.hooks.afterCreate((account) => sendWelcomeEmail(account.email));
Accounts.hooks.beforeDelete((id) => auditLog.record("account.delete", id));
```

Available hooks: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. A `before*` hook may return a partial payload that gets merged into the pending data (returning nothing leaves it unchanged); `after*` hooks are for side effects and run with the persisted record. Hooks run for single-row `create()` / `update()` / `delete()` only — bulk operations (`createMany` / `updateMany` / `deleteMany`) skip them by default, so a bulk call never silently re-fetches every affected row.

## Transactions

```typescript
await db.transaction(async (tx) => {
  const accounts = tx.getModel(Accounts);
  const transfers = tx.getModel(Transfers);

  const from = await accounts.update(fromId, { balance: fromBalance - amount });
  const to = await accounts.update(toId, { balance: toBalance + amount });
  await transfers.create({ fromId, toId, amount });

  if (from!.balance < 0) throw new Error("insufficient funds"); // rolls everything back
});
```

`tx.getModel(model)` exchanges an already-`defineModel`'d instance for a clone bound to the transaction — same schema and **the same hooks registry**, so hooks registered on the original model still fire. Every query made through the clone runs inside the transaction; throwing anywhere in the callback rolls it back and rejects `db.transaction()` with that error, otherwise it commits automatically.

- **PostgreSQL**: a dedicated pooled connection running `BEGIN` / `COMMIT` / `ROLLBACK`.
- **MongoDB**: a `ClientSession` (requires a replica set — same constraint as change streams).

## Querying

Filters use Mongo-style operators on both backends — compiled to parameterized SQL on PostgreSQL, passed (almost) natively to MongoDB. A plain value still means equality:

```typescript
const results = await Users.findAll(
  {
    age: { $gte: 18, $lt: 65 },          // comparisons
    name: { $like: "A%" },               // SQL LIKE (regex-safe on MongoDB)
    role: { $in: ["admin", "editor"] },  // membership
    deletedAt: { $null: true },          // IS NULL
    $or: [{ plan: "pro" }, { credits: { $gt: 0 } }],
  },
  {
    orderBy: { name: "asc" },
    limit: 20,
    offset: 40,
    select: ["id", "name", "email"],
  }
);
```

Operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$like`, `$null`, plus `$or` / `$and` combinators. Every column name in a filter is validated against the model schema, and every value is parameterized — unknown columns or malformed operators throw `QueryError` / `UnknownColumnError` before touching the database.

### Raw escape hatch

When the query engine isn't enough:

```typescript
// PostgreSQL — parameterized SQL:
const { rows } = (await db.raw(
  "SELECT name, COUNT(*) FROM users GROUP BY name HAVING COUNT(*) > $1",
  [1]
)) as { rows: unknown[] };

// MongoDB — a command document:
await db.raw({ ping: 1 });
```

## Supported data types

| IndigoDB type | PostgreSQL | MongoDB |
| --- | --- | --- |
| `INTEGER` | `INTEGER` | `Number` |
| `BIGINT` | `BIGINT` | `Number` (JS precision limit applies — see below) |
| `FLOAT` | `REAL` | `Number` |
| `DOUBLE` | `DOUBLE PRECISION` | `Number` |
| `DECIMAL` | `NUMERIC` (or `NUMERIC(precision, scale)`) | `String` (exact precision — see below) |
| `STRING` | `VARCHAR(255)` (or `VARCHAR(length)`) | `String` |
| `TEXT` | `TEXT` | `String` |
| `BOOLEAN` | `BOOLEAN` | `Boolean` |
| `DATE` | `TIMESTAMP` | `Date` |
| `DATEONLY` | `DATE` | `Date` |
| `UUID` | `UUID` | `String` |
| `ENUM` | `TEXT` + `CHECK` constraint | `String`, validated in the ORM |
| `BINARY` | `BYTEA` | `Buffer`, passed through unchanged |
| `JSON` | `JSONB` | `Object` |

Some types take extra options on the column definition:

```typescript
const Accounts = await db.defineModel<Account>("accounts", {
  id: { type: DataTypes.UUID, primaryKey: true, default: () => crypto.randomUUID() },
  code: { type: DataTypes.STRING, length: 12 },              // VARCHAR(12) instead of the default 255
  balance: { type: DataTypes.DECIMAL, precision: 12, scale: 2 }, // NUMERIC(12, 2)
  status: { type: DataTypes.ENUM, values: ["active", "suspended", "closed"] },
});
```

- **`DECIMAL`** is returned as a `string` on both backends (PostgreSQL's driver already does this for `NUMERIC`; MongoDB has no fixed-point type, so IndigoDB stores it as a string too) — a JS `Number` would silently round money-style values. Parse with a decimal library if you need arithmetic.
- **`BIGINT`** is still coerced through `Number`, so values beyond `Number.MAX_SAFE_INTEGER` (2^53) lose precision — fine for most IDs/counters, but avoid it for values that can legitimately exceed that range.
- **`ENUM`** requires `values: string[]`; anything outside that list is rejected with a `ValidationError` on `create()`/`update()` (and the bulk variants) on **both** backends — PostgreSQL additionally enforces it at the database level with a `CHECK` constraint.
- Misconfigured columns (`ENUM` without `values`, `length`/`precision`/`scale` used on the wrong type, a non-positive `length`) throw `ConfigurationError` at `defineModel()` time.

## Architecture

IndigoDB is intentionally small and built around a few classic patterns so new backends and transports are easy to add:

- **Adapter** — `DatabaseAdapter` has one implementation per backend (`PostgresAdapter`, `MongoAdapter`). `IndigoDB` never contains `if (type === ...)` CRUD branches.
- **Template Method** — `BaseModel<T>` defines the CRUD contract and centralizes identifier/schema validation and primary-key resolution; each backend model fills in the specifics.
- **Observer** — adapters emit a uniform `ChangeEvent`; `IndigoDB` re-emits it and forwards it to the real-time gateway.
- **Strategy** — `RealtimeGateway` abstracts the transport; `WebSocketGateway` is the default, and real-time is fully optional.

```
adapter.emitChange() ──▶ IndigoDB.emit("change") ──▶ your listener
                                    └────────────▶ gateway.broadcast() ──▶ WebSocket clients
```

- **PostgreSQL** detects changes with a per-table trigger that calls `pg_notify` on the `indigodb_changes` channel; a dedicated `LISTEN` client (separate from the query `Pool`) receives them.
- **MongoDB** detects changes with a `collection.watch()` change stream (requires a replica set).

## Schema migrations

`CREATE TABLE IF NOT EXISTS` (run by `defineModel`) never alters an existing table, so schema changes on a live database need real migrations. IndigoDB ships a small runner plus a CLI:

```bash
npx indigodb-migrate create "add users table"   # scaffolds migrations/<timestamp>_add_users_table.js
npx indigodb-migrate up                          # applies every pending migration
npx indigodb-migrate down                        # reverts the most recently applied one
npx indigodb-migrate status                      # { applied, pending }
```

The CLI reads `indigodb.config.js` (or `--config <path>`) from the working directory:

```javascript
// indigodb.config.js
module.exports = {
  database: { type: "postgresql", host: "localhost", database: "myapp" },
  migrationsDir: "./migrations", // optional, defaults to "./migrations"
};
```

A migration file exports `up`/`down` functions that receive a `MigrationContext` — the same `raw()` escape hatch as `db.raw()`:

```javascript
// migrations/1700000000000_add_users_table.js
module.exports = {
  async up(ctx) {
    await ctx.raw("CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE)");
  },
  async down(ctx) {
    await ctx.raw("DROP TABLE users");
  },
};
```

Applied migrations are tracked in a history table/collection (default name `indigodb_migrations`) defined the same way any other model is — no backend-specific bookkeeping. You can also drive it programmatically:

```typescript
import { MigrationRunner } from "@adinet/indigodb";

const runner = new MigrationRunner(db, { directory: "./migrations" });
await runner.up();
```

## Production hardening

### Redacting sensitive columns from real-time

Change events broadcast the full row by default. Strip columns that must never leave the server (password hashes, tokens, ...):

```typescript
const Accounts = await db.defineModel<Account>(
  "accounts",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING },
    passwordHash: { type: DataTypes.STRING },
  },
  { redact: ["passwordHash"] }
);
```

`redact` only affects `ChangeEvent`s (in-process `db.on("change", ...)` and WebSocket broadcasts) — `create()`/`findAll()`/etc. results are never redacted. Redacting a column that isn't in the schema throws `ConfigurationError` at `defineModel()` time.

### Opting a model out of real-time

Set `broadcast: false` to skip creating a Postgres trigger / opening a Mongo change stream for a model entirely — useful for high-write tables nobody subscribes to:

```typescript
await db.defineModel("audit_log", schema, { broadcast: false });
```

### TLS and connection pooling (PostgreSQL)

Most managed Postgres providers (RDS, Supabase, Neon, ...) require TLS:

```typescript
const db = new IndigoDB({
  database: {
    type: "postgresql",
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // or `true`, or a custom ssl config
    pool: { max: 20, idleTimeoutMillis: 30_000 },
  },
});
```

`ssl` also applies to the dedicated `LISTEN` connection used for real-time; `pool` only tunes the query pool.

### MongoDB driver options

```typescript
const db = new IndigoDB({
  database: {
    type: "mongodb",
    connectionString: process.env.MONGO_URL,
    options: { tls: true, maxPoolSize: 50 },
  },
});
```

### What happens when a row is too big for real-time

PostgreSQL's `pg_notify` caps payloads around 8KB. A row that exceeds it no longer blocks the write: the trigger falls back to a **truncated** event — `{ ..., truncated: true, data: { <primaryKey>: value } }` — instead of throwing and aborting the INSERT/UPDATE/DELETE. Re-fetch the record if you need the rest. The notify path is also wrapped in its own error handler, so any real-time failure can never roll back the triggering write.

### Schema drift detection

`defineModel()` never alters an existing table — `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists. If your schema has gained columns since the table was created, IndigoDB now logs a warning naming the missing columns and pointing at `indigodb-migrate` instead of failing silently until the first query breaks.

### MongoDB change-stream resilience

If a change stream errors (network blip, replica set election), the adapter automatically restarts it using the last-seen [resume token](https://www.mongodb.com/docs/manual/changeStreams/#resume-a-change-stream) so no events are missed. If the resume attempt itself fails before observing anything new — the token is presumably no longer in the oplog — it restarts fresh and logs a warning that some events may have been missed in between.

## Testing

The default suite is fully mocked and needs **no database**:

```bash
npm test
```

Opt-in integration tests run against live databases (PostgreSQL, and MongoDB as a replica set). Copy `.env.example` to `.env`, fill in your connection details, then:

```bash
npm run test:integration
```

CI runs the unit suite on Node 18/20/22 and the full integration suite against real Postgres and Mongo (single-node replica set) containers on every PR.

## Development

```bash
npm run lint     # ESLint + Prettier check
npm run format   # Prettier write
npm run docs     # Generate API docs (typedoc) into docs/
```

## Migration from v1

v2 is a breaking change. Key differences:

| v1 | v2 |
| --- | --- |
| `import { initialize, defineModel } from "indigodb"` (hidden singleton) | `import { IndigoDB } from "@adinet/indigodb"; const db = new IndigoDB(config)` |
| `initialize({ databaseType, host, ... })` | `new IndigoDB({ database: { type, host, ... } })` + `await db.connect()` |
| `defineModel()` was synchronous and returned `any` | `await db.defineModel<T>()` returns a typed `Model<T>` |
| WebSocket server always started | `realtime` is opt-in |
| Postgres records required a hardcoded `_id` column | primary key comes from the `primaryKey: true` column in your schema |
| No way to shut down (tests hung) | `await db.close()` releases everything |

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full gap analysis and release plan: schema features + hooks (v2.2), transactions (v2.3), migrations (v2.4), advanced real-time (v2.5), and relations (v3.0).

## Contributing

1. Fork the repository.
2. Create a branch (`feature/my-feature`).
3. Commit your changes.
4. Push and open a pull request.

## License

MIT — see [LICENSE](./LICENSE).
