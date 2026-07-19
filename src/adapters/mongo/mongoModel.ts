import { Collection, Document, Filter, ObjectId } from "mongodb";
import { BaseModel } from "../../models/baseModel";
import { ModelSchema } from "../../types";

export class MongoModel<T> extends BaseModel<T> {
  constructor(
    name: string,
    schema: ModelSchema,
    private readonly collection: Collection<Document>
  ) {
    // MongoDB documents always carry an _id, so it is the default primary key.
    super(name, schema, "_id");
  }

  private toId(id: unknown): unknown {
    if (
      this.primaryKey === "_id" &&
      typeof id === "string" &&
      ObjectId.isValid(id)
    ) {
      return new ObjectId(id);
    }
    return id;
  }

  private coerceTypes(data: Record<string, unknown>): Record<string, unknown> {
    this.assertKnownColumns(data);
    const coerced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const type = this.schema[key]?.type;
      if (value === null || value === undefined) {
        coerced[key] = value;
      } else if (type === "INTEGER" || type === "FLOAT") {
        coerced[key] = Number(value);
      } else if (type === "BOOLEAN") {
        coerced[key] = Boolean(value);
      } else if (type === "DATE" && !(value instanceof Date)) {
        coerced[key] = new Date(value as string | number);
      } else {
        coerced[key] = value;
      }
    }
    return coerced;
  }

  public async create(data: Partial<T>): Promise<T> {
    const document = this.coerceTypes(data as Record<string, unknown>);
    const result = await this.collection.insertOne(document);
    const inserted = await this.findById(result.insertedId);
    return inserted as T;
  }

  public async findAll(criteria: Partial<T> = {}): Promise<T[]> {
    const filter = this.coerceTypes(criteria as Record<string, unknown>);
    if ("_id" in filter) {
      filter._id = this.toId(filter._id);
    }
    const results = await this.collection
      .find(filter as Filter<Document>)
      .toArray();
    return results as T[];
  }

  public async findById(id: unknown): Promise<T | null> {
    const result = await this.collection.findOne({
      [this.primaryKey]: this.toId(id),
    } as Filter<Document>);
    return (result as T) ?? null;
  }

  public async update(id: unknown, data: Partial<T>): Promise<T | null> {
    const updates = this.coerceTypes(data as Record<string, unknown>);
    await this.collection.updateOne(
      { [this.primaryKey]: this.toId(id) } as Filter<Document>,
      { $set: updates }
    );
    return this.findById(id);
  }

  public async delete(id: unknown): Promise<T | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    await this.collection.deleteOne({
      [this.primaryKey]: this.toId(id),
    } as Filter<Document>);
    return existing;
  }
}
