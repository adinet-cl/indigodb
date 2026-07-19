import { ModelSchema } from "../types";
import { assertValidIdentifier } from "../identifiers";
import { ConfigurationError, UnknownColumnError } from "../errors";
import { QueryOptions, walkWhere, Where } from "../query/where";

/**
 * Template Method base for all database models: guarantees the same CRUD
 * contract across backends and centralizes schema/identifier validation and
 * primary-key resolution.
 */
export abstract class BaseModel<T> {
  public readonly name: string;
  public readonly schema: ModelSchema;
  public readonly primaryKey: string;

  protected constructor(
    name: string,
    schema: ModelSchema,
    defaultPrimaryKey?: string
  ) {
    this.name = assertValidIdentifier(name);
    for (const column of Object.keys(schema)) {
      assertValidIdentifier(column);
    }
    this.schema = schema;

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
