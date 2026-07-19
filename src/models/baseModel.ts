import { ModelSchema } from "../types";
import { assertValidIdentifier } from "../identifiers";
import { ConfigurationError, UnknownColumnError } from "../errors";

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

  /** Rejects payload/criteria keys that are not part of the schema. */
  protected assertKnownColumns(data: Record<string, unknown>): void {
    for (const key of Object.keys(data)) {
      if (key !== this.primaryKey && !this.schema[key]) {
        throw new UnknownColumnError(key, this.name);
      }
    }
  }

  public abstract create(data: Partial<T>): Promise<T>;
  public abstract findAll(criteria?: Partial<T>): Promise<T[]>;
  public abstract findById(id: unknown): Promise<T | null>;
  public abstract update(id: unknown, data: Partial<T>): Promise<T | null>;
  public abstract delete(id: unknown): Promise<T | null>;
}
