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

interface AssociationDef {
  type: "hasMany" | "belongsTo";
  target: BaseModel<unknown>;
  foreignKey: string;
  as: string;
}

export interface AssociationOptions {
  foreignKey: string;
  /** Property name the related record(s) are attached under. Defaults to the target model's name. */
  as?: string;
}

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
  private readonly associations = new Map<string, AssociationDef>();

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
  protected applyDefaults(
    data: Record<string, unknown>
  ): Record<string, unknown> {
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
    for (const name of options.include ?? []) {
      if (!this.associations.has(name)) {
        throw new ConfigurationError(
          `Unknown association "${name}" on model "${this.name}". ` +
            `Register it with hasMany()/belongsTo() before querying with it.`
        );
      }
    }
  }

  /**
   * One-to-many association: `this` owns many `target` rows, matched by
   * `target[foreignKey] === this[primaryKey]`. Attaches an array under `as`
   * (default: the target model's name) when the association is `include`d.
   */
  public hasMany<R>(target: BaseModel<R>, options: AssociationOptions): void {
    const as = options.as ?? target.name;
    this.associations.set(as, {
      type: "hasMany",
      target: target as unknown as BaseModel<unknown>,
      foreignKey: options.foreignKey,
      as,
    });
  }

  /**
   * Many-to-one association: `this[foreignKey]` points at one `target` row,
   * matched by `target[target.primaryKey] === this[foreignKey]`. Attaches a
   * single object (or `null`) under `as` when the association is `include`d.
   */
  public belongsTo<R>(target: BaseModel<R>, options: AssociationOptions): void {
    const as = options.as ?? target.name;
    this.associations.set(as, {
      type: "belongsTo",
      target: target as unknown as BaseModel<unknown>,
      foreignKey: options.foreignKey,
      as,
    });
  }

  /**
   * Resolves `options.include` for a page of rows with one batched query per
   * association (never one query per row): collects the relevant keys,
   * fetches every related record with a single `$in` query on the target
   * model, then joins in memory. Works identically on both backends since it
   * only calls the target's own `findAll()` — no backend-specific JOIN/
   * `$lookup` code needed.
   */
  protected async attachIncludes(rows: T[], include?: string[]): Promise<T[]> {
    if (!include || include.length === 0 || rows.length === 0) return rows;
    for (const name of include) {
      const assoc = this.associations.get(name);
      if (!assoc) continue; // already validated by assertKnownOptionColumns
      await this.attachOne(rows, assoc);
    }
    return rows;
  }

  private async attachOne(rows: T[], assoc: AssociationDef): Promise<void> {
    const records = rows as unknown as Record<string, unknown>[];
    // Join keys are compared via String(): Mongo ObjectIds deserialize as
    // distinct object instances, so identity-keyed Maps would never match.
    const keyOf = (value: unknown) => String(value);

    if (assoc.type === "hasMany") {
      const ids = [...new Set(records.map((r) => r[this.primaryKey]))];
      const related = (await assoc.target.findAll({
        [assoc.foreignKey]: { $in: ids },
      } as never)) as unknown as Record<string, unknown>[];

      const byForeignKey = new Map<string, Record<string, unknown>[]>();
      for (const record of related) {
        const key = keyOf(record[assoc.foreignKey]);
        const bucket = byForeignKey.get(key);
        if (bucket) bucket.push(record);
        else byForeignKey.set(key, [record]);
      }
      for (const row of records) {
        row[assoc.as] = byForeignKey.get(keyOf(row[this.primaryKey])) ?? [];
      }
      return;
    }

    // belongsTo
    const ids = [
      ...new Set(
        records
          .map((r) => r[assoc.foreignKey])
          .filter((v) => v !== null && v !== undefined)
      ),
    ];
    const related = (await assoc.target.findAll({
      [assoc.target.primaryKey]: { $in: ids },
    } as never)) as unknown as Record<string, unknown>[];

    const byPrimaryKey = new Map<string, Record<string, unknown>>();
    for (const record of related) {
      byPrimaryKey.set(keyOf(record[assoc.target.primaryKey]), record);
    }
    for (const row of records) {
      const foreignKey = row[assoc.foreignKey];
      row[assoc.as] =
        foreignKey === null || foreignKey === undefined
          ? null
          : (byPrimaryKey.get(keyOf(foreignKey)) ?? null);
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
  public abstract updateMany(
    where: Where<T>,
    data: Partial<T>
  ): Promise<number>;
  public abstract delete(id: unknown): Promise<T | null>;
  public abstract deleteMany(where: Where<T>): Promise<number>;
}
