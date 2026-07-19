import { EventEmitter } from "node:events";

const adapterMocks: MockAdapter[] = [];
const gatewayMocks: MockGateway[] = [];

const firstAdapter = () => adapterMocks[0]!;
const firstGateway = () => gatewayMocks[0]!;

class MockAdapter extends EventEmitter {
  connect = jest.fn().mockResolvedValue(undefined);
  disconnect = jest.fn().mockResolvedValue(undefined);
  defineModel = jest.fn().mockResolvedValue({ name: "users" });
  raw = jest.fn().mockResolvedValue({ rows: [] });
  transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  constructor() {
    super();
    adapterMocks.push(this);
  }
}

class MockGateway {
  start = jest.fn().mockResolvedValue(undefined);
  stop = jest.fn().mockResolvedValue(undefined);
  broadcast = jest.fn();
  port: number;
  constructor(port: number) {
    this.port = port;
    gatewayMocks.push(this);
  }
}

jest.mock("../../src/adapters/postgres/postgresAdapter", () => ({
  PostgresAdapter: jest.fn(() => new MockAdapter()),
}));
jest.mock("../../src/adapters/mongo/mongoAdapter", () => ({
  MongoAdapter: jest.fn(() => new MockAdapter()),
}));
jest.mock("../../src/realtime/websocketGateway", () => ({
  WebSocketGateway: jest.fn((port: number) => new MockGateway(port)),
}));

import { IndigoDB } from "../../src/indigodb";
import { PostgresAdapter } from "../../src/adapters/postgres/postgresAdapter";
import { MongoAdapter } from "../../src/adapters/mongo/mongoAdapter";
import { WebSocketGateway } from "../../src/realtime/websocketGateway";
import { ConfigurationError, ConnectionError } from "../../src/errors";
import { ChangeEvent, Config } from "../../src/types";
import { DataTypes } from "../../src/dataTypes";

const pgConfig: Config = {
  database: { type: "postgresql", host: "localhost", database: "test" },
};

describe("IndigoDB", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adapterMocks.length = 0;
    gatewayMocks.length = 0;
  });

  test("selects the PostgresAdapter for postgresql configs", () => {
    new IndigoDB(pgConfig);
    expect(PostgresAdapter).toHaveBeenCalled();
    expect(MongoAdapter).not.toHaveBeenCalled();
  });

  test("selects the MongoAdapter for mongodb configs", () => {
    new IndigoDB({
      database: { type: "mongodb", connectionString: "mongodb://localhost" },
    });
    expect(MongoAdapter).toHaveBeenCalled();
    expect(PostgresAdapter).not.toHaveBeenCalled();
  });

  test("throws ConfigurationError for unsupported database types", () => {
    expect(
      () => new IndigoDB({ database: { type: "oracle" } } as never)
    ).toThrow(ConfigurationError);
    expect(() => new IndigoDB({} as never)).toThrow(ConfigurationError);
  });

  test("does not create a gateway unless realtime is enabled", () => {
    new IndigoDB(pgConfig);
    expect(WebSocketGateway).not.toHaveBeenCalled();

    new IndigoDB({ ...pgConfig, realtime: { enabled: false } });
    expect(WebSocketGateway).not.toHaveBeenCalled();

    new IndigoDB({ ...pgConfig, realtime: { enabled: true, port: 9001 } });
    expect(WebSocketGateway).toHaveBeenCalledWith(
      9001,
      expect.anything(),
      undefined
    );
  });

  test("realtime port defaults to 8080", () => {
    new IndigoDB({ ...pgConfig, realtime: { enabled: true } });
    expect(WebSocketGateway).toHaveBeenCalledWith(
      8080,
      expect.anything(),
      undefined
    );
  });

  test("passes the authenticate hook through to the gateway", () => {
    const authenticate = jest.fn().mockReturnValue(true);
    new IndigoDB({
      ...pgConfig,
      realtime: { enabled: true, authenticate },
    });
    expect(WebSocketGateway).toHaveBeenCalledWith(
      8080,
      expect.anything(),
      authenticate
    );
  });

  test("connect starts adapter then gateway; close stops both", async () => {
    const db = new IndigoDB({ ...pgConfig, realtime: { enabled: true } });
    await db.connect();

    expect(firstAdapter().connect).toHaveBeenCalled();
    expect(firstGateway().start).toHaveBeenCalled();

    await db.close();
    expect(firstGateway().stop).toHaveBeenCalled();
    expect(firstAdapter().disconnect).toHaveBeenCalled();
  });

  test("connect rolls back the adapter if the gateway fails to start", async () => {
    const db = new IndigoDB({ ...pgConfig, realtime: { enabled: true } });
    firstGateway().start.mockRejectedValueOnce(new Error("EADDRINUSE"));

    await expect(db.connect()).rejects.toThrow("EADDRINUSE");

    expect(firstAdapter().connect).toHaveBeenCalled();
    expect(firstAdapter().disconnect).toHaveBeenCalled();
    await expect(
      db.defineModel("users", { id: { type: DataTypes.INTEGER, primaryKey: true } })
    ).rejects.toThrow(ConnectionError);
  });

  test("defineModel requires connect() first", async () => {
    const db = new IndigoDB(pgConfig);
    await expect(
      db.defineModel("users", { id: { type: DataTypes.INTEGER, primaryKey: true } })
    ).rejects.toThrow(ConnectionError);
  });

  test("defineModel delegates to the adapter after connect", async () => {
    const db = new IndigoDB(pgConfig);
    await db.connect();
    const schema = { id: { type: DataTypes.INTEGER, primaryKey: true } };

    const model = await db.defineModel("users", schema);

    expect(firstAdapter().defineModel).toHaveBeenCalledWith(
      "users",
      schema,
      undefined
    );
    expect(model).toEqual({ name: "users" });
  });

  test("raw requires connect() and delegates to the adapter", async () => {
    const db = new IndigoDB(pgConfig);
    await expect(db.raw("SELECT 1")).rejects.toThrow(ConnectionError);

    await db.connect();
    await db.raw("SELECT $1", [1]);
    expect(firstAdapter().raw).toHaveBeenCalledWith("SELECT $1", [1]);
  });

  test("transaction requires connect() and delegates to the adapter", async () => {
    const db = new IndigoDB(pgConfig);
    await expect(db.transaction(async () => undefined)).rejects.toThrow(
      ConnectionError
    );

    await db.connect();
    const fn = async () => "result";
    await expect(db.transaction(fn)).resolves.toBe("result");
    expect(firstAdapter().transaction).toHaveBeenCalledWith(fn);
  });

  test("adapter change events are re-emitted and broadcast to the gateway", async () => {
    const db = new IndigoDB({ ...pgConfig, realtime: { enabled: true } });
    await db.connect();

    const received: ChangeEvent[] = [];
    db.on("change", (event: ChangeEvent) => received.push(event));

    const event: ChangeEvent = {
      model: "users",
      operation: "INSERT",
      data: { id: 1 },
    };
    firstAdapter().emit("change", event);

    expect(received).toEqual([event]);
    expect(firstGateway().broadcast).toHaveBeenCalledWith(
      "databaseUpdate",
      event
    );
  });
});
