import { ObjectId } from "mongodb";
import { MongoModel } from "../../src/adapters/mongo/mongoModel";
import { DataTypes } from "../../src/dataTypes";
import { UnknownColumnError } from "../../src/errors";
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
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
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
      { $set: { price: 19.99 } }
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

    expect(collection.deleteOne).toHaveBeenCalledWith({ _id: id });
    expect(result).toEqual(existing);
  });
});
