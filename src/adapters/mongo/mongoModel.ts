import { Collection, Document, Filter, ObjectId } from "mongodb";
import { BaseModel } from "../../models/baseModel";
import { ModelSchema } from "../../types";

/** Parses booleans without JS's `Boolean("false") === true` footgun. */
function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0" || normalized === "") {
      return false;
    }
  }
  return Boolean(value);
}

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
        coerced[key] = toBoolean(value);
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
    // Re-read by the driver-assigned _id, not the (possibly custom) primary
    // key, which may not be populated on the just-inserted document.
    const inserted = await this.collection.findOne({
      _id: result.insertedId,
    } as Filter<Document>);
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
