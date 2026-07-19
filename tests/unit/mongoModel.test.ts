import { ObjectId } from "mongodb";
import { MongoModel } from "../../src/adapters/mongo/mongoModel";
import { DataTypes } from "../../src/dataTypes";
import {
  ConfigurationError,
  UnknownColumnError,
  ValidationError,
} from "../../src/errors";
import { ModelSchema } from "../../src/types";

interface Product {
  _id?: unknown;
  name: string;
  price: number;
  inStock: boolean;
  releasedAt: Date;
}

const productSchema: ModelSchema = {
  name: { type: DataTypes.STRING },
  price: { type: DataTypes.FLOAT },
  inStock: { type: DataTypes.BOOLEAN },
  releasedAt: { type: DataTypes.DATE },
};

function makeCollection() {
  return {
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    insertMany: jest.fn().mockResolvedValue({ insertedIds: {} }),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    countDocuments: jest.fn().mockResolvedValue(0),
    createIndex: jest.fn().mockResolvedValue("index-name"),
  };
}

function makeModel(collection = makeCollection()) {
  return {
    model: new MongoModel<Product>("products", productSchema, collection as never),
    collection,
  };
}

describe("MongoModel", () => {
  test("defaults the primary key to _id", () => {
    const { model } = makeModel();
    expect(model.primaryKey).toBe("_id");
  });

  test("create coerces values according to the schema", async () => {
    const { model, collection } = makeModel();
    const inserted = { _id: new ObjectId(), name: "Widget" };
    collection.findOne.mockResolvedValue(inserted);

    await model.create({
      name: "Widget",
      price: "9.99" as never,
      inStock: 1 as never,
      releasedAt: "2026-01-01" as never,
    });

    const document = collection.insertOne.mock.calls[0][0];
    expect(document.price).toBe(9.99);
    expect(document.inStock).toBe(true);
    expect(document.releasedAt).toBeInstanceOf(Date);
  });

  test("BOOLEAN coercion treats string 'false'/'0' as false", async () => {
    const { model, collection } = makeModel();
    collection.findOne.mockResolvedValue({ _id: new ObjectId() });

    await model.create({ inStock: "false" as never } as never);
    expect(collection.insertOne.mock.calls[0][0].inStock).toBe(false);

    await model.create({ inStock: "0" as never } as never);
    expect(collection.insertOne.mock.calls[1][0].inStock).toBe(false);

    await model.create({ inStock: "true" as never } as never);
    expect(collection.insertOne.mock.calls[2][0].inStock).toBe(true);
  });

  test("create re-reads the inserted document by _id, not the primary key", async () => {
    const { model, collection } = makeModel();
    const insertedId = new ObjectId();
    collection.insertOne.mockResolvedValue({ insertedId });
    const doc = { _id: insertedId, name: "Widget" };
    collection.findOne.mockResolvedValue(doc);

    const result = await model.create({ name: "Widget" });

    expect(collection.findOne).toHaveBeenCalledWith({ _id: insertedId }, {});
    expect(result).toEqual(doc);
  });

  test("create rejects fields not in the schema", async () => {
    const { model } = makeModel();
    await expect(
      model.create({ hacked: true } as never)
    ).rejects.toThrow(UnknownColumnError);
  });

  test("findById converts valid ObjectId strings", async () => {
    const { model, collection } = makeModel();
    const id = new ObjectId();

    await model.findById(id.toHexString());

    const filter = collection.findOne.mock.calls[0][0];
    expect(filter._id).toBeInstanceOf(ObjectId);
    expect(filter._id.equals(id)).toBe(true);
  });

  test("findById passes non-ObjectId ids through unchanged", async () => {
    const { model, collection } = makeModel();
    await model.findById("plain-string-id");
    expect(collection.findOne.mock.calls[0][0]._id).toBe("plain-string-id");
  });

  test("update uses $set with coerced data and returns the fresh document", async () => {
    const { model, collection } = makeModel();
    const id = new ObjectId();
    const updated = { _id: id, name: "Widget", price: 19.99 };
    collection.findOne.mockResolvedValue(updated);

    const result = await model.update(id, { price: "19.99" as never });

    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: id },
      { $set: { price: 19.99 } },
      {}
    );
    expect(result).toEqual(updated);
  });

  test("delete returns null when the document does not exist", async () => {
    const { model, collection } = makeModel();
    const result = await model.delete(new ObjectId());
    expect(result).toBeNull();
    expect(collection.deleteOne).not.toHaveBeenCalled();
  });

  test("delete returns the removed document", async () => {
    const { model, collection } = makeModel();
    const id = new ObjectId();
    const existing = { _id: id, name: "Widget" };
    collection.findOne.mockResolvedValue(existing);

    const result = await model.delete(id);

    expect(collection.deleteOne).toHaveBeenCalledWith({ _id: id }, {});
    expect(result).toEqual(existing);
  });

  function makeCursor() {
    const cursor = {
      sort: jest.fn(),
      skip: jest.fn(),
      limit: jest.fn(),
      project: jest.fn(),
      toArray: jest.fn().mockResolvedValue([]),
    };
    cursor.sort.mockReturnValue(cursor);
    cursor.skip.mockReturnValue(cursor);
    cursor.limit.mockReturnValue(cursor);
    cursor.project.mockReturnValue(cursor);
    return cursor;
  }

  test("findAll compiles operators and applies sort/skip/limit/projection", async () => {
    const collection = makeCollection();
    const cursor = makeCursor();
    collection.find.mockReturnValue(cursor);
    const { model } = makeModel(collection);

    await model.findAll(
      { price: { $gte: 10, $lt: 100 } },
      {
        orderBy: { price: "desc" },
        offset: 5,
        limit: 10,
        select: ["name", "price"],
      }
    );

    expect(collection.find).toHaveBeenCalledWith(
      { price: { $gte: 10, $lt: 100 } },
      {}
    );
    expect(cursor.sort).toHaveBeenCalledWith({ price: -1 });
    expect(cursor.skip).toHaveBeenCalledWith(5);
    expect(cursor.limit).toHaveBeenCalledWith(10);
    expect(cursor.project).toHaveBeenCalledWith({ name: 1, price: 1 });
  });

  test("findAll coerces filter values by schema", async () => {
    const collection = makeCollection();
    const cursor = makeCursor();
    collection.find.mockReturnValue(cursor);
    const { model } = makeModel(collection);

    await model.findAll({ price: { $gt: "9.99" as never }, inStock: 1 as never });

    expect(collection.find).toHaveBeenCalledWith(
      { price: { $gt: 9.99 }, inStock: true },
      {}
    );
  });

  test("findAll rejects unknown columns anywhere in the tree", async () => {
    const { model } = makeModel();
    await expect(
      model.findAll({ $or: [{ hacked: 1 }] } as never)
    ).rejects.toThrow(UnknownColumnError);
  });

  test("count delegates to countDocuments with the compiled filter", async () => {
    const collection = makeCollection();
    collection.countDocuments = jest.fn().mockResolvedValue(4);
    const { model } = makeModel(collection);

    await expect(model.count({ inStock: true })).resolves.toBe(4);
    expect(collection.countDocuments).toHaveBeenCalledWith({ inStock: true }, {});
  });

  test("exists uses a minimal projection", async () => {
    const collection = makeCollection();
    collection.findOne.mockResolvedValue({ _id: new ObjectId() });
    const { model } = makeModel(collection);

    await expect(model.exists({ name: "Widget" })).resolves.toBe(true);
    expect(collection.findOne).toHaveBeenCalledWith(
      { name: "Widget" },
      { projection: { _id: 1 } }
    );
  });

  test("createMany inserts coerced docs and returns them in input order", async () => {
    const collection = makeCollection();
    const idA = new ObjectId();
    const idB = new ObjectId();
    collection.insertMany = jest
      .fn()
      .mockResolvedValue({ insertedIds: { 0: idA, 1: idB } });
    const docA = { _id: idA, name: "A" };
    const docB = { _id: idB, name: "B" };
    const cursor = makeCursor();
    // find() returns them out of order on purpose.
    cursor.toArray.mockResolvedValue([docB, docA]);
    collection.find.mockReturnValue(cursor);
    const { model } = makeModel(collection);

    const result = await model.createMany([
      { name: "A", price: "1" as never },
      { name: "B" },
    ]);

    expect(collection.insertMany).toHaveBeenCalledWith(
      [{ name: "A", price: 1 }, { name: "B" }],
      {}
    );
    expect(result).toEqual([docA, docB]);
  });

  test("updateMany returns modifiedCount", async () => {
    const collection = makeCollection();
    collection.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 5 });
    const { model } = makeModel(collection);

    const affected = await model.updateMany(
      { inStock: false },
      { price: "0" as never }
    );

    expect(collection.updateMany).toHaveBeenCalledWith(
      { inStock: false },
      { $set: { price: 0 } },
      {}
    );
    expect(affected).toBe(5);
  });

  test("deleteMany returns deletedCount", async () => {
    const collection = makeCollection();
    collection.deleteMany = jest.fn().mockResolvedValue({ deletedCount: 2 });
    const { model } = makeModel(collection);

    await expect(model.deleteMany({ inStock: false })).resolves.toBe(2);
    expect(collection.deleteMany).toHaveBeenCalledWith({ inStock: false }, {});
  });
});

describe("MongoModel schema completeness", () => {
  interface Account {
    _id?: unknown;
    email: string;
    plan: string;
    createdAt?: Date;
    updatedAt?: Date;
  }

  const accountSchema: ModelSchema = {
    email: { type: DataTypes.STRING, required: true, unique: true },
    plan: { type: DataTypes.STRING, default: "free" },
  };

  test("init creates a unique index for unique columns and a plain one for index columns", async () => {
    const schema: ModelSchema = {
      email: { type: DataTypes.STRING, unique: true },
      status: { type: DataTypes.STRING, index: true },
      plain: { type: DataTypes.STRING },
    };
    const collection = makeCollection();
    const model = new MongoModel("accounts", schema, collection as never);

    await model.init();

    expect(collection.createIndex).toHaveBeenCalledWith(
      { email: 1 },
      { unique: true }
    );
    expect(collection.createIndex).toHaveBeenCalledWith({ status: 1 });
    expect(collection.createIndex).toHaveBeenCalledTimes(2);
  });

  test("create applies default values for missing fields", async () => {
    const collection = makeCollection();
    const inserted = { _id: new ObjectId(), email: "a@x.com", plan: "free" };
    collection.findOne.mockResolvedValue(inserted);
    const model = new MongoModel<Account>("accounts", accountSchema, collection as never);

    await model.create({ email: "a@x.com" });

    expect(collection.insertOne).toHaveBeenCalledWith(
      { email: "a@x.com", plan: "free" },
      {}
    );
  });

  test("create throws ValidationError when a required field is missing", async () => {
    const collection = makeCollection();
    const model = new MongoModel<Account>("accounts", accountSchema, collection as never);
    await expect(model.create({ plan: "pro" })).rejects.toThrow(ValidationError);
  });

  test("timestamps: create stamps createdAt/updatedAt and update refreshes updatedAt", async () => {
    const collection = makeCollection();
    collection.findOne.mockResolvedValue({ _id: new ObjectId() });
    const model = new MongoModel<Account>("accounts", accountSchema, collection as never, {
      timestamps: true,
    });

    await model.create({ email: "a@x.com" });
    const inserted = collection.insertOne.mock.calls[0][0];
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(inserted.updatedAt).toBeInstanceOf(Date);

    await model.update(new ObjectId(), { plan: "pro" });
    const updateArgs = collection.updateOne.mock.calls[0][1];
    expect(updateArgs.$set.updatedAt).toBeInstanceOf(Date);
  });

  test("hooks: beforeCreate can transform the payload, afterCreate observes the record", async () => {
    const collection = makeCollection();
    const inserted = { _id: new ObjectId(), email: "a@x.com", plan: "free" };
    collection.findOne.mockResolvedValue(inserted);
    const model = new MongoModel<Account>("accounts", accountSchema, collection as never);

    const afterCreateCalls: Account[] = [];
    model.hooks.beforeCreate((data) => ({
      email: (data.email as string).toLowerCase(),
    }));
    model.hooks.afterCreate((record) => {
      afterCreateCalls.push(record);
    });

    await model.create({ email: "A@X.COM" });

    expect(collection.insertOne).toHaveBeenCalledWith(
      { email: "a@x.com", plan: "free" },
      {}
    );
    expect(afterCreateCalls).toEqual([inserted]);
  });

  test("hooks: beforeDelete/afterDelete run around delete()", async () => {
    const collection = makeCollection();
    const existing = { _id: new ObjectId(), email: "a@x.com", plan: "free" };
    collection.findOne.mockResolvedValue(existing);
    const model = new MongoModel<Account>("accounts", accountSchema, collection as never);

    const events: string[] = [];
    model.hooks.beforeDelete((id) => {
      events.push(`before:${id}`);
    });
    model.hooks.afterDelete((record) => {
      events.push(`after:${record.email}`);
    });

    await model.delete(existing._id);
    expect(events).toEqual([`before:${existing._id}`, "after:a@x.com"]);
  });

  test("createMany applies defaults per row and skips hooks", async () => {
    const collection = makeCollection();
    const model = new MongoModel<Account>("accounts", accountSchema, collection as never);
    const beforeCreateCalls: unknown[] = [];
    model.hooks.beforeCreate((data) => {
      beforeCreateCalls.push(data);
    });

    await model.createMany([{ email: "a@x.com" }, { email: "b@x.com" }]);

    expect(collection.insertMany).toHaveBeenCalledWith(
      [{ email: "a@x.com", plan: "free" }, { email: "b@x.com", plan: "free" }],
      {}
    );
    expect(beforeCreateCalls).toHaveLength(0);
  });
});

describe("MongoModel relations", () => {
  interface RelUser {
    _id?: unknown;
    name: string;
  }
  interface RelPost {
    _id?: unknown;
    title: string;
    userId: unknown;
  }

  const relUserSchema: ModelSchema = {
    name: { type: DataTypes.STRING },
  };
  const relPostSchema: ModelSchema = {
    title: { type: DataTypes.STRING },
    userId: { type: DataTypes.STRING },
  };

  function cursorOf(docs: unknown[]) {
    return { toArray: jest.fn().mockResolvedValue(docs) };
  }

  test("hasMany + include batches a single query per association and attaches results", async () => {
    const userId1 = new ObjectId();
    const userId2 = new ObjectId();
    const usersCollection = makeCollection();
    usersCollection.find.mockReturnValue(
      cursorOf([
        { _id: userId1, name: "Ada" },
        { _id: userId2, name: "Bob" },
      ])
    );
    const users = new MongoModel<RelUser>("users", relUserSchema, usersCollection as never);

    const postsCollection = makeCollection();
    postsCollection.find.mockReturnValue(
      cursorOf([
        { _id: new ObjectId(), title: "Post A", userId: userId1 },
        { _id: new ObjectId(), title: "Post B", userId: userId1 },
        { _id: new ObjectId(), title: "Post C", userId: userId2 },
      ])
    );
    const posts = new MongoModel<RelPost>("posts", relPostSchema, postsCollection as never);

    users.hasMany(posts, { foreignKey: "userId", as: "posts" });

    const result = await users.findAll({}, { include: ["posts"] });

    expect(postsCollection.find).toHaveBeenCalledTimes(1);
    expect((result[0] as unknown as { posts: unknown[] }).posts).toHaveLength(2);
    expect((result[1] as unknown as { posts: unknown[] }).posts).toHaveLength(1);
  });

  test("belongsTo + include attaches a single related record or null", async () => {
    const userId = new ObjectId();
    const usersCollection = makeCollection();
    usersCollection.find.mockReturnValue(cursorOf([{ _id: userId, name: "Ada" }]));
    const users = new MongoModel<RelUser>("users", relUserSchema, usersCollection as never);

    const postsCollection = makeCollection();
    postsCollection.find.mockReturnValue(
      cursorOf([
        { _id: new ObjectId(), title: "Post A", userId },
        { _id: new ObjectId(), title: "Orphan", userId: new ObjectId() },
      ])
    );
    const posts = new MongoModel<RelPost>("posts", relPostSchema, postsCollection as never);

    posts.belongsTo(users, { foreignKey: "userId", as: "author" });

    const result = await posts.findAll({}, { include: ["author"] });

    expect((result[0] as unknown as { author: { name: string } }).author.name).toBe(
      "Ada"
    );
    expect((result[1] as unknown as { author: unknown }).author).toBeNull();
  });

  test("findAll rejects an unregistered include name", async () => {
    const collection = makeCollection();
    const model = new MongoModel<RelPost>("posts", relPostSchema, collection as never);
    await expect(model.findAll({}, { include: ["nope"] })).rejects.toThrow(
      ConfigurationError
    );
  });

  test("include is a no-op for an empty result set (no extra query issued)", async () => {
    const usersCollection = makeCollection();
    usersCollection.find.mockReturnValue(cursorOf([]));
    const users = new MongoModel<RelUser>("users", relUserSchema, usersCollection as never);
    const postsCollection = makeCollection();
    const posts = new MongoModel<RelPost>("posts", relPostSchema, postsCollection as never);
    users.hasMany(posts, { foreignKey: "userId", as: "posts" });

    await users.findAll({}, { include: ["posts"] });
    expect(postsCollection.find).not.toHaveBeenCalled();
  });
});
