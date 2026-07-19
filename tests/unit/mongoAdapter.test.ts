import { EventEmitter } from "node:events";

const mockCollection = {
  watch: jest.fn(),
  insertOne: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
  createIndex: jest.fn().mockResolvedValue("index-name"),
};

const mockDb = {
  collection: jest.fn(() => mockCollection),
  command: jest.fn(),
};

function makeMockSession() {
  return {
    endSession: jest.fn().mockResolvedValue(undefined),
    withTransaction: jest.fn(async (fn: () => Promise<unknown>) => {
      await fn();
    }),
  };
}

jest.mock("mongodb", () => {
  const actual = jest.requireActual("mongodb");
  return {
    ...actual,
    MongoClient: jest.fn(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      db: jest.fn(() => mockDb),
      startSession: jest.fn(() => makeMockSession()),
    })),
  };
});

import { MongoClient, ObjectId } from "mongodb";
import { MongoAdapter } from "../../src/adapters/mongo/mongoAdapter";
import { DataTypes } from "../../src/dataTypes";
import { ConfigurationError } from "../../src/errors";
import { ChangeEvent, MongoConfig } from "../../src/types";

const config: MongoConfig = {
  type: "mongodb",
  connectionString: "mongodb://localhost:27017/test",
};

class MockChangeStream extends EventEmitter {
  close = jest.fn().mockResolvedValue(undefined);
}

describe("MongoAdapter", () => {
  let stream: MockChangeStream;

  beforeEach(() => {
    jest.clearAllMocks();
    stream = new MockChangeStream();
    mockCollection.watch.mockReturnValue(stream);
  });

  async function connectedAdapterWithModel() {
    const adapter = new MongoAdapter(config);
    await adapter.connect();
    await adapter.defineModel("products", {
      name: { type: DataTypes.STRING },
    });
    const events: ChangeEvent[] = [];
    adapter.on("change", (event: ChangeEvent) => events.push(event));
    return { adapter, events };
  }

  test("requires a connectionString", () => {
    expect(
      () => new MongoAdapter({ type: "mongodb", connectionString: "" })
    ).toThrow(ConfigurationError);
  });

  test("defineModel opens a change stream with updateLookup", async () => {
    await connectedAdapterWithModel();
    expect(mockCollection.watch).toHaveBeenCalledWith([], {
      fullDocument: "updateLookup",
    });
  });

  test("redefining a model does not open a second change stream", async () => {
    const adapter = new MongoAdapter(config);
    await adapter.connect();
    const schema = { name: { type: DataTypes.STRING } };

    const first = await adapter.defineModel("products", schema);
    const second = await adapter.defineModel("products", schema);

    expect(mockCollection.watch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    // A single change must therefore be emitted only once.
    const events: ChangeEvent[] = [];
    adapter.on("change", (event: ChangeEvent) => events.push(event));
    stream.emit("change", {
      operationType: "insert",
      fullDocument: { _id: new ObjectId() },
    });
    expect(events).toHaveLength(1);
  });

  test("warns when redefining a model with a different schema", async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const adapter = new MongoAdapter(config, logger);
    await adapter.connect();

    await adapter.defineModel("products", { name: { type: DataTypes.STRING } });
    await adapter.defineModel("products", {
      name: { type: DataTypes.STRING },
      price: { type: DataTypes.FLOAT },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("already defined")
    );
    expect(mockCollection.watch).toHaveBeenCalledTimes(1);
  });

  test("insert events are broadcast as INSERT", async () => {
    const { events } = await connectedAdapterWithModel();
    const doc = { _id: new ObjectId(), name: "Widget" };

    stream.emit("change", { operationType: "insert", fullDocument: doc });

    expect(events).toEqual([
      { model: "products", operation: "INSERT", data: doc },
    ]);
  });

  test("update and replace events are broadcast as UPDATE with the full document", async () => {
    const { events } = await connectedAdapterWithModel();
    const doc = { _id: new ObjectId(), name: "Updated" };

    stream.emit("change", { operationType: "update", fullDocument: doc });
    stream.emit("change", { operationType: "replace", fullDocument: doc });

    expect(events).toEqual([
      { model: "products", operation: "UPDATE", data: doc },
      { model: "products", operation: "UPDATE", data: doc },
    ]);
  });

  test("delete events carry the document key", async () => {
    const { events } = await connectedAdapterWithModel();
    const id = new ObjectId();

    stream.emit("change", {
      operationType: "delete",
      documentKey: { _id: id },
    });

    expect(events).toEqual([
      { model: "products", operation: "DELETE", data: { _id: id } },
    ]);
  });

  test("unknown operations are ignored", async () => {
    const { events } = await connectedAdapterWithModel();
    stream.emit("change", { operationType: "drop" });
    expect(events).toEqual([]);
  });

  test("raw runs command documents and rejects non-objects", async () => {
    const adapter = new MongoAdapter(config);
    await adapter.connect();
    mockDb.command.mockResolvedValue({ ok: 1 });

    await expect(adapter.raw({ ping: 1 })).resolves.toEqual({ ok: 1 });
    expect(mockDb.command).toHaveBeenCalledWith({ ping: 1 });

    await expect(adapter.raw("SELECT 1")).rejects.toThrow(
      "expects a command document"
    );
  });

  test("disconnect closes change streams and the client", async () => {
    const { adapter } = await connectedAdapterWithModel();
    await adapter.disconnect();

    expect(stream.close).toHaveBeenCalled();
    const clientInstance = (MongoClient as unknown as jest.Mock).mock
      .results[0]!.value;
    expect(clientInstance.close).toHaveBeenCalled();
  });

  describe("transaction()", () => {
    function lastClientInstance() {
      return (MongoClient as unknown as jest.Mock).mock.results[0]!.value;
    }

    test("runs fn inside session.withTransaction and ends the session", async () => {
      const adapter = new MongoAdapter(config);
      await adapter.connect();

      const result = await adapter.transaction(async () => "done");

      expect(result).toBe("done");
      const client = lastClientInstance();
      const session = client.startSession.mock.results[0].value;
      expect(session.withTransaction).toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalled();
    });

    test("propagates errors thrown by fn and still ends the session", async () => {
      const adapter = new MongoAdapter(config);
      await adapter.connect();

      await expect(
        adapter.transaction(async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      const client = lastClientInstance();
      const session = client.startSession.mock.results[0].value;
      expect(session.endSession).toHaveBeenCalled();
    });

    test("getModel() binds the model to the transaction session and shares hooks", async () => {
      const cursor = { toArray: jest.fn().mockResolvedValue([]) };
      mockCollection.find.mockReturnValue(cursor);

      const { adapter } = await connectedAdapterWithModel();
      const model = await adapter.defineModel("products", {
        name: { type: DataTypes.STRING },
      });

      let seenSameHooks = false;
      await adapter.transaction(async (tx) => {
        const txModel = tx.getModel(model);
        seenSameHooks = txModel.hooks === model.hooks;
        await txModel.findAll();
      });

      expect(seenSameHooks).toBe(true);
      const client = lastClientInstance();
      const session = client.startSession.mock.results[0].value;
      // findAll() passed the session through to the driver call.
      expect(mockCollection.find).toHaveBeenCalledWith({}, { session });
    });

    test("throws when connect() was not called first", async () => {
      const adapter = new MongoAdapter(config);
      await expect(adapter.transaction(async () => undefined)).rejects.toThrow(
        "not connected"
      );
    });
  });
});
