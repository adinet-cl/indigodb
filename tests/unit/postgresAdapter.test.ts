import { EventEmitter } from "node:events";

jest.mock("pg", () => {
  const { EventEmitter } = require("node:events");

  class MockClient extends EventEmitter {
    connect = jest.fn().mockResolvedValue(undefined);
    query = jest.fn().mockResolvedValue({ rows: [] });
    end = jest.fn().mockResolvedValue(undefined);
  }

  class MockPool extends EventEmitter {
    query = jest.fn().mockResolvedValue({ rows: [] });
    end = jest.fn().mockResolvedValue(undefined);
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
});
