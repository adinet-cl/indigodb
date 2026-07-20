import { ClientSession, Collection, Document, Filter, ObjectId } from "mongodb";
import { BaseModel } from "../../models/baseModel";
import { HookRegistry } from "../../models/hooks";
import { ModelOptions, ModelSchema } from "../../types";
import {
  assertNonNegativeInteger,
  QueryOptions,
  Where,
} from "../../query/where";
import { compileFilter } from "./filterCompiler";

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
    private readonly collection: Collection<Document>,
    options: ModelOptions = {},
    sharedHooks?: HookRegistry<T>,
    private readonly session?: ClientSession
  ) {
    // MongoDB documents always carry an _id, so it is the default primary key.
    super(name, schema, "_id", options, sharedHooks);
  }

  /**
   * Returns a clone bound to a transaction session — same collection, schema
   * and hooks, but every operation is passed `{ session }` so it participates
   * in the transaction. Used by MongoAdapter.transaction().
   */
  public withSession(session: ClientSession): MongoModel<T> {
    return new MongoModel<T>(
      this.name,
      this.schema,
      this.collection,
      {
        timestamps: this.timestamps,
        broadcast: this.broadcastEnabled,
        redact: [...this.redactedColumns],
      },
      this.hooks,
      session
    );
  }

  /** Merges `{ session }` into driver call options when running in a transaction. */
  private withOptions<O extends object>(
    extra?: O
  ): O & { session?: ClientSession } {
    return this.session
      ? { ...(extra ?? ({} as O)), session: this.session }
      : (extra ?? ({} as O));
  }

  /** Creates unique/non-unique indexes declared in the schema. */
  public async init(): Promise<void> {
    for (const [column, definition] of Object.entries(this.schema)) {
      if (column === this.primaryKey) continue;
      if (definition.unique) {
        await this.collection.createIndex({ [column]: 1 }, { unique: true });
      } else if (definition.index) {
        await this.collection.createIndex({ [column]: 1 });
      }
    }
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

  /** Coerces a single value according to the schema (and ObjectId for the PK). */
  private coerceValue = (field: string, value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (field === this.primaryKey) return this.toId(value);
    const type = this.schema[field]?.type;
    if (
      type === "INTEGER" ||
      type === "BIGINT" ||
      type === "FLOAT" ||
      type === "DOUBLE"
    ) {
      return Number(value);
    }
    // Stored as a string to preserve exact precision (Mongo has no fixed-point
    // decimal type suitable for money-style values; a JS Number would round).
    if (type === "DECIMAL") return String(value);
    if (type === "BOOLEAN") return toBoolean(value);
    if ((type === "DATE" || type === "DATEONLY") && !(value instanceof Date)) {
      return new Date(value as string | number);
    }
    if (type === "UUID" || type === "ENUM") return String(value);
    // BINARY and JSON pass through unchanged (Buffer / plain object as given).
    return value;
  };

  private coerceTypes(data: Record<string, unknown>): Record<string, unknown> {
    this.assertKnownColumns(data);
    const coerced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      coerced[key] = this.coerceValue(key, value);
    }
    return coerced;
  }

  /** Validates + compiles a Where tree into a native Mongo filter. */
  private buildFilter(where: Where<T>): Filter<Document> {
    this.assertKnownWhereColumns(where as Record<string, unknown>);
    return compileFilter(
      where as Record<string, unknown>,
      this.coerceValue
    ) as Filter<Document>;
  }

  public async create(data: Partial<T>): Promise<T> {
    this.assertKnownColumns(data as Record<string, unknown>);
    const withDefaults = this.prepareForCreate(data as Record<string, unknown>);
    const afterHooks = await this.hooks.runBeforeCreate(
      withDefaults as Partial<T>
    );
    const document = this.coerceTypes(afterHooks as Record<string, unknown>);
    const result = await this.collection.insertOne(
      document,
      this.withOptions()
    );
    // Re-read by the driver-assigned _id, not the (possibly custom) primary
    // key, which may not be populated on the just-inserted document.
    const inserted = await this.collection.findOne(
      { _id: result.insertedId } as Filter<Document>,
      this.withOptions()
    );
    await this.hooks.runAfterCreate(inserted as T);
    return inserted as T;
  }

  public async findAll(
    where: Where<T> = {},
    options: QueryOptions<T> = {}
  ): Promise<T[]> {
    this.assertKnownOptionColumns(options);
    let cursor = this.collection.find(
      this.buildFilter(where),
      this.withOptions()
    );

    const orderEntries = Object.entries(options.orderBy ?? {});
    if (orderEntries.length > 0) {
      cursor = cursor.sort(
        Object.fromEntries(
          orderEntries.map(([column, direction]) => [
            column,
            direction === "asc" ? 1 : -1,
          ])
        )
      );
    }
    if (options.offset !== undefined) {
      cursor = cursor.skip(assertNonNegativeInteger(options.offset, "offset"));
    }
    if (options.limit !== undefined) {
      cursor = cursor.limit(assertNonNegativeInteger(options.limit, "limit"));
    }
    if (options.select?.length) {
      cursor = cursor.project(
        Object.fromEntries(options.select.map((column) => [column, 1]))
      );
    }

    const results = await cursor.toArray();
    return this.attachIncludes(results as T[], options.include);
  }

  public async findOne(
    where: Where<T> = {},
    options: QueryOptions<T> = {}
  ): Promise<T | null> {
    const rows = await this.findAll(where, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  public async count(where: Where<T> = {}): Promise<number> {
    return this.collection.countDocuments(
      this.buildFilter(where),
      this.withOptions()
    );
  }

  public async exists(where: Where<T> = {}): Promise<boolean> {
    const found = await this.collection.findOne(
      this.buildFilter(where),
      this.withOptions({ projection: { _id: 1 } })
    );
    return found !== null;
  }

  public async createMany(data: Partial<T>[]): Promise<T[]> {
    if (data.length === 0) return [];
    // Hooks are skipped for bulk operations (see HookRegistry docs); defaults,
    // timestamps and required-column validation still apply per row.
    const documents = data.map((row) => {
      const record = row as Record<string, unknown>;
      this.assertKnownColumns(record);
      return this.coerceTypes(this.prepareForCreate(record));
    });
    const result = await this.collection.insertMany(
      documents,
      this.withOptions()
    );
    const ids = Object.values(result.insertedIds);
    const inserted = await this.collection
      .find({ _id: { $in: ids } } as Filter<Document>, this.withOptions())
      .toArray();
    // Preserve input order (find() does not guarantee it).
    const byId = new Map(inserted.map((doc) => [String(doc._id), doc]));
    return ids
      .map((id) => byId.get(String(id)))
      .filter(
        (doc): doc is NonNullable<typeof doc> => doc !== undefined
      ) as T[];
  }

  public async updateMany(where: Where<T>, data: Partial<T>): Promise<number> {
    const stamped = this.prepareForUpdate(data as Record<string, unknown>);
    const updates = this.coerceTypes(stamped);
    if (Object.keys(updates).length === 0) return 0;
    const result = await this.collection.updateMany(
      this.buildFilter(where),
      { $set: updates },
      this.withOptions()
    );
    return result.modifiedCount;
  }

  public async deleteMany(where: Where<T>): Promise<number> {
    const result = await this.collection.deleteMany(
      this.buildFilter(where),
      this.withOptions()
    );
    return result.deletedCount;
  }

  public async findById(id: unknown): Promise<T | null> {
    const result = await this.collection.findOne(
      { [this.primaryKey]: this.toId(id) } as Filter<Document>,
      this.withOptions()
    );
    return (result as T) ?? null;
  }

  public async update(id: unknown, data: Partial<T>): Promise<T | null> {
    this.assertKnownColumns(data as Record<string, unknown>);
    const stamped = this.prepareForUpdate(data as Record<string, unknown>);
    const afterHooks = await this.hooks.runBeforeUpdate(
      id,
      stamped as Partial<T>
    );
    const updates = this.coerceTypes(afterHooks as Record<string, unknown>);
    await this.collection.updateOne(
      { [this.primaryKey]: this.toId(id) } as Filter<Document>,
      { $set: updates },
      this.withOptions()
    );
    const row = await this.findById(id);
    if (row) await this.hooks.runAfterUpdate(row);
    return row;
  }

  public async delete(id: unknown): Promise<T | null> {
    await this.hooks.runBeforeDelete(id);
    const existing = await this.findById(id);
    if (!existing) return null;
    await this.collection.deleteOne(
      { [this.primaryKey]: this.toId(id) } as Filter<Document>,
      this.withOptions()
    );
    await this.hooks.runAfterDelete(existing);
    return existing;
  }
}
