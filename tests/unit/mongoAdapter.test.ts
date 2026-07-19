import { EventEmitter } from "node:events";

const mockCollection = {
  watch: jest.fn(),
  insertOne: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
};

const mockDb = { collection: jest.fn(() => mockCollection) };

jest.mock("mongodb", () => {
  const actual = jest.requireActual("mongodb");
  return {
    ...actual,
    MongoClient: jest.fn(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      db: jest.fn(() => mockDb),
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

  test("disconnect closes change streams and the client", async () => {
    const { adapter } = await connectedAdapterWithModel();
    await adapter.disconnect();

    expect(stream.close).toHaveBeenCalled();
    const clientInstance = (MongoClient as unknown as jest.Mock).mock.results[0]!
      .value;
    expect(clientInstance.close).toHaveBeenCalled();
  });
});
