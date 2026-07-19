import { ModelOptions, ModelSchema } from "../types";
import { assertValidIdentifier } from "../identifiers";
import {
  ConfigurationError,
  UnknownColumnError,
  ValidationError,
} from "../errors";
import { QueryOptions, walkWhere, Where } from "../query/where";
import { HookRegistry } from "./hooks";

export const TIMESTAMP_COLUMNS = ["createdAt", "updatedAt"] as const;

/**
 * Template Method base for all database models: guarantees the same CRUD
 * contract across backends and centralizes schema/identifier validation and
 * primary-key resolution.
 */
export abstract class BaseModel<T> {
  public readonly name: string;
  public readonly schema: ModelSchema;
  public readonly primaryKey: string;
  public readonly timestamps: boolean;
  public readonly hooks: HookRegistry<T>;

  protected constructor(
    name: string,
    schema: ModelSchema,
    defaultPrimaryKey?: string,
    options: ModelOptions = {},
    /**
     * Shares an existing HookRegistry instead of creating a new one — used by
     * transaction-bound clones (see PostgresModel.withClient /
     * MongoModel.withSession) so hooks registered on the original model also
     * run for operations performed through the transaction handle.
     */
    sharedHooks?: HookRegistry<T>
  ) {
    this.hooks = sharedHooks ?? new HookRegistry<T>();
    this.name = assertValidIdentifier(name);
    for (const column of Object.keys(schema)) {
      assertValidIdentifier(column);
    }
    this.timestamps = options.timestamps ?? false;
    this.schema = this.timestamps
      ? {
          ...schema,
          createdAt: { type: "DATE" },
          updatedAt: { type: "DATE" },
        }
      : schema;

    const declaredPrimaryKey = Object.entries(schema).find(
      ([, definition]) => definition.primaryKey
    )?.[0];
    const primaryKey = declaredPrimaryKey ?? defaultPrimaryKey;
    if (!primaryKey) {
      throw new ConfigurationError(
        `Model "${name}" must declare a primaryKey column in its schema`
      );
    }
    this.primaryKey = primaryKey;
  }

  /** Fills in `default` values for columns missing from the payload. */
  protected applyDefaults(data: Record<string, unknown>): Record<string, unknown> {
    const result = { ...data };
    for (const [column, definition] of Object.entries(this.schema)) {
      if (result[column] === undefined && definition.default !== undefined) {
        result[column] =
          typeof definition.default === "function"
            ? definition.default()
            : definition.default;
      }
    }
    return result;
  }

  /** Throws ValidationError for `required` columns still missing after defaults. */
  protected assertRequiredColumns(data: Record<string, unknown>): void {
    for (const [column, definition] of Object.entries(this.schema)) {
      if (
        definition.required &&
        (data[column] === undefined || data[column] === null)
      ) {
        throw new ValidationError(column, this.name);
      }
    }
  }

  /** Applies defaults + required validation; the shared create()-time pipeline. */
  protected prepareForCreate(
    data: Record<string, unknown>
  ): Record<string, unknown> {
    const withDefaults = this.applyDefaults(data);
    const withTimestamps = this.timestamps
      ? { ...withDefaults, createdAt: new Date(), updatedAt: new Date() }
      : withDefaults;
    this.assertRequiredColumns(withTimestamps);
    return withTimestamps;
  }

  /** Stamps `updatedAt` on update() payloads when timestamps are enabled. */
  protected prepareForUpdate(
    data: Record<string, unknown>
  ): Record<string, unknown> {
    return this.timestamps ? { ...data, updatedAt: new Date() } : data;
  }

  /** Rejects payload keys that are not part of the schema. */
  protected assertKnownColumns(data: Record<string, unknown>): void {
    for (const key of Object.keys(data)) {
      this.assertKnownColumn(key);
    }
  }

  /** Rejects a single column name that is not part of the schema. */
  protected assertKnownColumn(column: string): void {
    if (column !== this.primaryKey && !this.schema[column]) {
      throw new UnknownColumnError(column, this.name);
    }
  }

  /** Validates every column referenced in a Where tree (incl. $or/$and). */
  protected assertKnownWhereColumns(where: Record<string, unknown>): void {
    walkWhere(where, (field) => this.assertKnownColumn(field));
  }

  /** Validates the column names used in orderBy/select options. */
  protected assertKnownOptionColumns(options: QueryOptions<T>): void {
    for (const column of Object.keys(options.orderBy ?? {})) {
      this.assertKnownColumn(column);
    }
    for (const column of options.select ?? []) {
      this.assertKnownColumn(column);
    }
  }

  public abstract create(data: Partial<T>): Promise<T>;
  public abstract createMany(data: Partial<T>[]): Promise<T[]>;
  public abstract findAll(
    where?: Where<T>,
    options?: QueryOptions<T>
  ): Promise<T[]>;
  public abstract findOne(
    where?: Where<T>,
    options?: QueryOptions<T>
  ): Promise<T | null>;
  public abstract findById(id: unknown): Promise<T | null>;
  public abstract count(where?: Where<T>): Promise<number>;
  public abstract exists(where?: Where<T>): Promise<boolean>;
  public abstract update(id: unknown, data: Partial<T>): Promise<T | null>;
  public abstract updateMany(where: Where<T>, data: Partial<T>): Promise<number>;
  public abstract delete(id: unknown): Promise<T | null>;
  public abstract deleteMany(where: Where<T>): Promise<number>;
}
