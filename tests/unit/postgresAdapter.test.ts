import { EventEmitter } from "node:events";

jest.mock("pg", () => {
  const { EventEmitter } = require("node:events");

  class MockClient extends EventEmitter {
    connect = jest.fn().mockResolvedValue(undefined);
    query = jest.fn().mockResolvedValue({ rows: [] });
    end = jest.fn().mockResolvedValue(undefined);
  }

  class MockPoolClient extends EventEmitter {
    query = jest.fn().mockResolvedValue({ rows: [] });
    release = jest.fn();
  }

  class MockPool extends EventEmitter {
    query = jest.fn().mockResolvedValue({ rows: [] });
    end = jest.fn().mockResolvedValue(undefined);
    connect = jest.fn().mockImplementation(() => Promise.resolve(new MockPoolClient()));
  }

  return {
    Client: jest.fn(() => new MockClient()),
    Pool: jest.fn(() => new MockPool()),
  };
});

import { Client, Pool } from "pg";
import { PostgresAdapter } from "../../src/adapters/postgres/postgresAdapter";
import { DataTypes } from "../../src/dataTypes";
import { ChangeEvent, PostgresConfig } from "../../src/types";

const config: PostgresConfig = {
  type: "postgresql",
  host: "localhost",
  port: 5432,
  user: "test",
  password: "test",
  database: "test",
};

type MockInstance = EventEmitter & {
  connect: jest.Mock;
  query: jest.Mock;
  end: jest.Mock;
};

function lastInstance(mockedCtor: unknown): MockInstance {
  const results = (mockedCtor as jest.Mock).mock.results;
  return results[results.length - 1]!.value as MockInstance;
}

describe("PostgresAdapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("connect verifies the pool and subscribes to the notification channel", async () => {
    const adapter = new PostgresAdapter(config);
    await adapter.connect();

    const pool = lastInstance(Pool);
    expect(pool.query).toHaveBeenCalledWith("SELECT 1");

    const listenClient = lastInstance(Client);
    expect(listenClient.connect).toHaveBeenCalled();
    expect(listenClient.query).toHaveBeenCalledWith("LISTEN indigodb_changes");
  });

  test("emits change events for valid notification payloads", async () => {
    const adapter = new PostgresAdapter(config);
    await adapter.connect();

    const received: ChangeEvent[] = [];
    adapter.on("change", (event: ChangeEvent) => received.push(event));

    const listenClient = lastInstance(Client);
    const payload = {
      model: "users",
      operation: "INSERT",
      data: { id: 1, name: "Ada" },
    };
    listenClient.emit("notification", {
      channel: "indigodb_changes",
      payload: JSON.stringify(payload),
    });

    expect(received).toEqual([payload]);
  });

  test("ignores malformed notification payloads without crashing", async () => {
    const adapter = new PostgresAdapter(config);
    await adapter.connect();

    const received: ChangeEvent[] = [];
    adapter.on("change", (event: ChangeEvent) => received.push(event));

    const listenClient = lastInstance(Client);
    expect(() =>
      listenClient.emit("notification", { payload: "not-json{" })
    ).not.toThrow();
    listenClient.emit("notification", { payload: undefined });

    expect(received).toEqual([]);
  });

  test("defineModel waits for table and trigger creation", async () => {
    const adapter = new PostgresAdapter(config);
    await adapter.connect();

    const model = await adapter.defineModel("users", {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      name: { type: DataTypes.STRING },
    });

    expect(model.name).toBe("users");
    expect(model.primaryKey).toBe("id");

    const pool = lastInstance(Pool);
    const statements = pool.query.mock.calls.map((call) => call[0] as string);
    expect(statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS "users"'))).toBe(true);
    expect(statements.some((sql) => sql.includes("CREATE TRIGGER"))).toBe(true);
  });

  test("defineModel throws when not connected", async () => {
    const adapter = new PostgresAdapter(config);
    await expect(
      adapter.defineModel("users", {
        id: { type: DataTypes.INTEGER, primaryKey: true },
      })
    ).rejects.toThrow("not connected");
  });

  test("disconnect closes the listener and the pool", async () => {
    const adapter = new PostgresAdapter(config);
    await adapter.connect();

    const pool = lastInstance(Pool);
    const listenClient = lastInstance(Client);

    await adapter.disconnect();

    expect(listenClient.end).toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalled();
  });

  test("raw executes SQL through the pool and rejects non-strings", async () => {
    const adapter = new PostgresAdapter(config);
    await adapter.connect();
    const pool = lastInstance(Pool);
    pool.query.mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 });

    const result = await adapter.raw("SELECT $1::int AS ok", [1]);

    expect(pool.query).toHaveBeenCalledWith("SELECT $1::int AS ok", [1]);
    expect(result).toEqual({ rows: [{ ok: 1 }], rowCount: 1 });

    await expect(adapter.raw({ not: "sql" })).rejects.toThrow(
      "expects a SQL string"
    );
  });

  test("raw throws when not connected", async () => {
    const adapter = new PostgresAdapter(config);
    await expect(adapter.raw("SELECT 1")).rejects.toThrow("not connected");
  });

  test("connect releases the pool if the listener fails to connect", async () => {
    (Client as unknown as jest.Mock).mockImplementationOnce(() => {
      const client = new EventEmitter() as MockInstance;
      client.connect = jest.fn().mockRejectedValue(new Error("listen failed"));
      client.query = jest.fn().mockResolvedValue({ rows: [] });
      client.end = jest.fn().mockResolvedValue(undefined);
      return client;
    });

    const adapter = new PostgresAdapter(config);
    await expect(adapter.connect()).rejects.toThrow("listen failed");

    // The pool opened before the failure must be drained.
    expect(lastInstance(Pool).end).toHaveBeenCalled();
  });

  describe("transaction()", () => {
    async function lastClient(adapter: PostgresAdapter) {
      await adapter.connect();
      const pool = lastInstance(Pool) as unknown as {
        connect: jest.Mock;
      };
      // Trigger transaction() first so we can grab the client it acquired.
      return pool.connect;
    }

    test("wraps fn in BEGIN/COMMIT and commits on success", async () => {
      const adapter = new PostgresAdapter(config);
      const connectMock = await lastClient(adapter);

      const result = await adapter.transaction(async () => "done");

      expect(result).toBe("done");
      const client = await connectMock.mock.results[0]!.value;
      expect(client.query.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        "BEGIN",
        "COMMIT",
      ]);
      expect(client.release).toHaveBeenCalled();
    });

    test("rolls back and rethrows when fn throws", async () => {
      const adapter = new PostgresAdapter(config);
      const connectMock = await lastClient(adapter);

      await expect(
        adapter.transaction(async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      const client = await connectMock.mock.results[0]!.value;
      expect(client.query.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        "BEGIN",
        "ROLLBACK",
      ]);
      expect(client.release).toHaveBeenCalled();
    });

    test("getModel() binds the model to the transaction's client", async () => {
      const adapter = new PostgresAdapter(config);
      const connectMock = await lastClient(adapter);
      const model = await adapter.defineModel("users", {
        id: { type: DataTypes.INTEGER, primaryKey: true },
      });

      let seenSameHooks = false;
      await adapter.transaction(async (tx) => {
        const txModel = tx.getModel(model);
        seenSameHooks = txModel.hooks === model.hooks;
        await txModel.findAll();
      });

      const client = await connectMock.mock.results[0]!.value;
      expect(seenSameHooks).toBe(true);
      // findAll() ran on the transaction client, not the pool directly.
      expect(client.query.mock.calls.some((c: unknown[]) => (c[0] as string).includes("SELECT"))).toBe(true);
    });

    test("throws when connect() was not called first", async () => {
      const adapter = new PostgresAdapter(config);
      await expect(adapter.transaction(async () => undefined)).rejects.toThrow(
        "not connected"
      );
    });
  });
});
