# IndigoDB

IndigoDB is a lightweight ORM for Node.js that works against **either PostgreSQL or MongoDB**, with real-time change notifications pushed to clients over a built-in WebSocket server. It's inspired by Firebase's real-time database behavior: define a model, run CRUD, and connected clients are notified of every insert/update/delete automatically.

> **v2.0.0 is a full rewrite** with a new instance-based API, opt-in real-time, typed models, and a pluggable adapter architecture. See the [Migration guide](#migration-from-v1) if you are upgrading from v1.

## Features

- **Dual database support** — one API over PostgreSQL and MongoDB, swapped by config.
- **Real-time updates (opt-in)** — Postgres triggers + `LISTEN/NOTIFY` and MongoDB change streams are fanned out to WebSocket clients through a uniform payload.
- **Fully typed** — `defineModel<T>()` returns a typed `Model<T>`; no `any` leaking into your code.
- **Safe by default** — table/column identifiers are validated (anti SQL-injection) and all values are parameterized.
- **Explicit lifecycle** — `connect()` / `close()` cleanly open and release every resource (pool, listener, change streams, WebSocket server).
- **Injectable logger** — the library is silent unless you pass a `Logger`.

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

The payload shape is identical whether the change originated in PostgreSQL or MongoDB, so a single frontend handler covers both backends.

## API reference

### `new IndigoDB(config)`

| Config field | Description |
| --- | --- |
| `database` | Discriminated by `type`. PostgreSQL: `{ type: "postgresql", host, port, user, password, database }` (or `connectionString`). MongoDB: `{ type: "mongodb", connectionString, database? }`. |
| `realtime` | Optional. `{ enabled: boolean, port?: number }` — defaults to port `8080`. When omitted or `enabled: false`, **no WebSocket server is started**. |
| `logger` | Optional `Logger`. Defaults to a no-op; pass `consoleLogger` (exported) or your own. |

### Methods

- **`connect(): Promise<void>`** — connects the adapter (fails fast on bad credentials) and starts the WebSocket server if real-time is enabled.
- **`defineModel<T>(name, schema, options?): Promise<Model<T>>`** — creates the table/collection (indexes, Postgres triggers) and resolves once it is ready. **Async** — always `await` it. `options.timestamps: true` adds managed `createdAt`/`updatedAt` columns.
- **`on("change", listener)`** — subscribe to `ChangeEvent`s in-process (inherited from `EventEmitter`).
- **`transaction<R>(fn): Promise<R>`** — see [Transactions](#transactions).
- **`close(): Promise<void>`** — stops the WebSocket server, closes change streams, and drains the connection pool / client.

### Model methods

| Method | Description |
| --- | --- |
| `create(data)` | Insert a record; returns the created row. |
| `createMany(data[])` | Bulk insert (single multi-row INSERT / `insertMany`); returns the created rows. |
| `findAll(where?, options?)` | Query with operators, `orderBy`, `limit`, `offset`, `select`. |
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
| `STRING` | `VARCHAR(255)` | `String` |
| `FLOAT` | `REAL` | `Number` |
| `BOOLEAN` | `BOOLEAN` | `Boolean` |
| `DATE` | `TIMESTAMP` | `Date` |
| `TEXT` | `TEXT` | `String` |
| `JSON` | `JSONB` | `Object` |

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

## Testing

The default suite is fully mocked and needs **no database**:

```bash
npm test
```

Opt-in integration tests run against live databases. Copy `.env.example` to `.env`, fill in your connection details, then:

```bash
npm run test:integration
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
