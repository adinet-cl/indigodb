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
- **`defineModel<T>(name, schema): Promise<Model<T>>`** — creates the table/collection (and Postgres triggers) and resolves once it is ready. **Async** — always `await` it.
- **`on("change", listener)`** — subscribe to `ChangeEvent`s in-process (inherited from `EventEmitter`).
- **`close(): Promise<void>`** — stops the WebSocket server, closes change streams, and drains the connection pool / client.

### Model methods

| Method | Description |
| --- | --- |
| `create(data)` | Insert a record; returns the created row. |
| `findAll(criteria?)` | Return all records matching an optional equality filter. |
| `findById(id)` | Return a record by its primary key, or `null`. |
| `update(id, data)` | Update by primary key; returns the updated row or `null`. |
| `delete(id)` | Delete by primary key; returns the deleted row or `null`. |

The primary key is taken from the column marked `primaryKey: true` in the schema (PostgreSQL), or defaults to `_id` (MongoDB).

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

- Additional adapters (MySQL, SQLite).
- Additional real-time gateways (SSE, socket.io).
- Query builder / richer filtering beyond equality.

## Contributing

1. Fork the repository.
2. Create a branch (`feature/my-feature`).
3. Commit your changes.
4. Push and open a pull request.

## License

MIT — see [LICENSE](./LICENSE).
