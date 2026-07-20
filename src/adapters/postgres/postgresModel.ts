import type { Pool } from "pg";
import { BaseModel } from "../../models/baseModel";
import { ColumnDefinition, ModelOptions, ModelSchema } from "../../types";
import { assertValidIdentifier } from "../../identifiers";
import { POSTGRES_TYPE_MAP } from "../../dataTypes";
import { QueryError, UnsupportedTypeError } from "../../errors";
import { NOTIFICATION_CHANNEL } from "./constants";
import {
  assertNonNegativeInteger,
  QueryOptions,
  Where,
} from "../../query/where";
import { compileWhere } from "./whereCompiler";
import { HookRegistry } from "../../models/hooks";
import { Logger, noopLogger } from "../../logger";

/**
 * pg_notify payloads are capped at ~8000 bytes; past that the call throws
 * inside the trigger, which would abort the user's write. Leave headroom.
 */
const NOTIFY_PAYLOAD_LIMIT_BYTES = 7900;

/** Minimal query surface the model needs; satisfied by pg.Pool. */
export interface QueryExecutor {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/**
 * Double-quotes an identifier so reserved words (user, order, end, ...) and
 * case-sensitive names are valid SQL. The name is already validated by
 * assertValidIdentifier, so it cannot contain a quote to escape.
 */
function quote(identifier: string): string {
  return `"${identifier}"`;
}

/** Escapes a string as a single-quoted SQL literal (for ENUM CHECK constraints). */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Resolves the base SQL type, applying STRING length / DECIMAL precision+scale. */
function resolveSqlType(props: ColumnDefinition): string {
  if (props.type === "STRING") {
    return `VARCHAR(${props.length ?? 255})`;
  }
  if (props.type === "DECIMAL" && props.precision !== undefined) {
    return props.scale !== undefined
      ? `NUMERIC(${props.precision}, ${props.scale})`
      : `NUMERIC(${props.precision})`;
  }
  return POSTGRES_TYPE_MAP[props.type];
}

export class PostgresModel<T> extends BaseModel<T> {
  private readonly pool: QueryExecutor;
  private readonly logger: Logger;

  constructor(
    name: string,
    schema: ModelSchema,
    pool: QueryExecutor | Pool,
    options: ModelOptions = {},
    sharedHooks?: HookRegistry<T>,
    logger: Logger = noopLogger
  ) {
    // No default primary key: Postgres schemas must declare one explicitly.
    super(name, schema, undefined, options, sharedHooks);
    this.pool = pool as QueryExecutor;
    this.logger = logger;
  }

  /**
   * Returns a clone bound to a different query executor (e.g. a transaction
   * client) that shares this model's schema and hooks. Skips init() — the
   * table/triggers/indexes already exist. Used by PostgresAdapter.transaction().
   */
  public withClient(client: QueryExecutor): PostgresModel<T> {
    return new PostgresModel<T>(
      this.name,
      this.schema,
      client,
      {
        timestamps: this.timestamps,
        broadcast: this.broadcastEnabled,
        redact: [...this.redactedColumns],
      },
      this.hooks,
      this.logger
    );
  }

  /** Creates the table, indexes and change-notification triggers. Must complete before CRUD. */
  public async init(): Promise<void> {
    await this.createTable();
    await this.createIndexes();
    await this.setupTriggers();
    await this.warnOnSchemaDrift();
  }

  private async createTable(): Promise<void> {
    const columns: string[] = [];
    for (const [columnName, columnProps] of Object.entries(this.schema)) {
      if (!POSTGRES_TYPE_MAP[columnProps.type]) {
        throw new UnsupportedTypeError(columnProps.type);
      }
      const quotedColumn = quote(columnName);
      let columnDef = `${quotedColumn} ${resolveSqlType(columnProps)}`;
      if (columnProps.autoIncrement)
        columnDef += " GENERATED ALWAYS AS IDENTITY";
      if (columnProps.primaryKey) columnDef += " PRIMARY KEY";
      if (columnProps.unique) columnDef += " UNIQUE";
      if (columnProps.required && !columnProps.primaryKey)
        columnDef += " NOT NULL";
      if (columnProps.references) {
        const refTable = quote(
          assertValidIdentifier(columnProps.references.model)
        );
        const refColumn = quote(
          assertValidIdentifier(columnProps.references.column ?? "id")
        );
        columnDef += ` REFERENCES ${refTable} (${refColumn})`;
      }
      if (columnProps.type === "ENUM") {
        const allowed = columnProps.values!.map(quoteLiteral).join(", ");
        columnDef += ` CHECK (${quotedColumn} IN (${allowed}))`;
      }
      columns.push(columnDef);
    }

    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${quote(this.name)} (${columns.join(", ")});`
    );
  }

  private async createIndexes(): Promise<void> {
    for (const [columnName, columnProps] of Object.entries(this.schema)) {
      if (!columnProps.index || columnProps.primaryKey || columnProps.unique) {
        continue;
      }
      const indexName = quote(`${this.name}_${columnName}_idx`);
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS ${indexName} ON ${quote(this.name)} (${quote(columnName)});`
      );
    }
  }

  private async setupTriggers(): Promise<void> {
    const functionName = quote(`notify_${this.name}_change`);
    const triggerName = quote(`${this.name}_change_trigger`);
    const table = quote(this.name);

    // broadcast: false — make sure no trigger fires for this model, including
    // one left behind by a previous run that had broadcasting enabled.
    if (!this.broadcastEnabled) {
      await this.pool.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON ${table};`
      );
      return;
    }

    // The notify block is wrapped in its own EXCEPTION handler: real-time is
    // best-effort and must NEVER abort the user's INSERT/UPDATE/DELETE. When
    // the row exceeds the pg_notify payload limit, fall back to a truncated
    // event carrying only the primary key.
    const createFunctionQuery = `
      CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $$
      DECLARE
        record RECORD;
        payload TEXT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          record := OLD;
        ELSE
          record := NEW;
        END IF;
        BEGIN
          payload := json_build_object(
            'model', '${this.name}',
            'operation', TG_OP,
            'data', row_to_json(record)
          )::text;
          IF octet_length(payload) > ${NOTIFY_PAYLOAD_LIMIT_BYTES} THEN
            payload := json_build_object(
              'model', '${this.name}',
              'operation', TG_OP,
              'truncated', true,
              'data', json_build_object('${this.primaryKey}', record.${quote(this.primaryKey)})
            )::text;
          END IF;
          PERFORM pg_notify('${NOTIFICATION_CHANNEL}', payload);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `;

    const createTriggerQuery = `
      DROP TRIGGER IF EXISTS ${triggerName} ON ${table};
      CREATE TRIGGER ${triggerName}
      AFTER INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `;

    await this.pool.query(createFunctionQuery);
    await this.pool.query(createTriggerQuery);
  }

  /**
   * CREATE TABLE IF NOT EXISTS never alters an existing table, so a schema
   * that gained columns silently diverges from the database until the first
   * failing query. Detect that here and point at the migration tooling.
   */
  private async warnOnSchemaDrift(): Promise<void> {
    const result = await this.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1;`,
      [this.name]
    );
    const dbColumns = result.rows.map(
      (row) => (row as { column_name: string }).column_name
    );
    // An empty result means we couldn't introspect (permissions, mocks) —
    // don't warn on unknowns.
    if (dbColumns.length === 0) return;

    const missing = Object.keys(this.schema).filter(
      (column) => !dbColumns.includes(column)
    );
    if (missing.length > 0) {
      this.logger.warn(
        `Table "${this.name}" is missing columns declared in the schema: ` +
          `${missing.join(", ")}. CREATE TABLE IF NOT EXISTS never alters an ` +
          `existing table — write a migration (indigodb-migrate create) to add them.`
      );
    }
  }

  public async create(data: Partial<T>): Promise<T> {
    this.assertKnownColumns(data as Record<string, unknown>);
    const withDefaults = this.prepareForCreate(data as Record<string, unknown>);
    const afterHooks = await this.hooks.runBeforeCreate(
      withDefaults as Partial<T>
    );
    const entries = Object.entries(afterHooks as Record<string, unknown>);

    let row: unknown;
    if (entries.length === 0) {
      const result = await this.pool.query(
        `INSERT INTO ${quote(this.name)} DEFAULT VALUES RETURNING *;`
      );
      row = result.rows[0];
    } else {
      const columns = entries.map(([key]) => quote(key)).join(", ");
      const values = entries.map(([, value]) => value);
      const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

      const result = await this.pool.query(
        `INSERT INTO ${quote(this.name)} (${columns}) VALUES (${placeholders}) RETURNING *;`,
        values
      );
      row = result.rows[0];
    }

    await this.hooks.runAfterCreate(row as T);
    return row as T;
  }

  public async findAll(
    where: Where<T> = {},
    options: QueryOptions<T> = {}
  ): Promise<T[]> {
    const { sql, values } = this.buildSelect("*", where, options);
    const result = await this.pool.query(sql, values);
    return this.attachIncludes(result.rows as T[], options.include);
  }

  public async findOne(
    where: Where<T> = {},
    options: QueryOptions<T> = {}
  ): Promise<T | null> {
    const rows = await this.findAll(where, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  public async count(where: Where<T> = {}): Promise<number> {
    const { sql, values } = this.buildSelect(
      "COUNT(*)::int AS count",
      where,
      {}
    );
    const result = await this.pool.query(sql, values);
    const row = result.rows[0] as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  public async exists(where: Where<T> = {}): Promise<boolean> {
    const { sql, values } = this.buildSelect("1 AS one", where, { limit: 1 });
    const result = await this.pool.query(sql, values);
    return result.rows.length > 0;
  }

  public async createMany(data: Partial<T>[]): Promise<T[]> {
    if (data.length === 0) return [];

    // Hooks are skipped for bulk operations (see HookRegistry docs); defaults,
    // timestamps and required-column validation still apply per row.
    const prepared = data.map((row) => {
      const record = row as Record<string, unknown>;
      this.assertKnownColumns(record);
      return this.prepareForCreate(record);
    });

    const columns = Object.keys(prepared[0]!);
    if (columns.length === 0) {
      throw new QueryError("createMany rows must have at least one column");
    }

    const values: unknown[] = [];
    const rowsSql = prepared.map((record) => {
      const keys = Object.keys(record);
      if (
        keys.length !== columns.length ||
        !columns.every((column) => column in record)
      ) {
        throw new QueryError(
          "createMany requires every row to resolve to the same columns " +
            "(check for inconsistent optional fields or per-row defaults)"
        );
      }
      const placeholders = columns.map((column) => {
        values.push(record[column]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    const columnList = columns.map((column) => quote(column)).join(", ");
    const result = await this.pool.query(
      `INSERT INTO ${quote(this.name)} (${columnList}) VALUES ${rowsSql.join(", ")} RETURNING *;`,
      values
    );
    return result.rows as T[];
  }

  public async updateMany(where: Where<T>, data: Partial<T>): Promise<number> {
    this.assertKnownColumns(data as Record<string, unknown>);
    this.assertKnownWhereColumns(where as Record<string, unknown>);
    const stamped = this.prepareForUpdate(data as Record<string, unknown>);

    const entries = Object.entries(stamped);
    if (entries.length === 0) return 0;

    const values = entries.map(([, value]) => value);
    const updates = entries.map(
      ([key], index) => `${quote(key)} = $${index + 1}`
    );

    const compiled = compileWhere(
      where as Record<string, unknown>,
      quote,
      values.length + 1
    );
    values.push(...compiled.values);

    let sql = `UPDATE ${quote(this.name)} SET ${updates.join(", ")}`;
    if (compiled.sql) sql += ` WHERE ${compiled.sql}`;

    const result = await this.pool.query(sql, values);
    return result.rowCount ?? 0;
  }

  public async deleteMany(where: Where<T>): Promise<number> {
    this.assertKnownWhereColumns(where as Record<string, unknown>);
    const compiled = compileWhere(where as Record<string, unknown>, quote);

    let sql = `DELETE FROM ${quote(this.name)}`;
    if (compiled.sql) sql += ` WHERE ${compiled.sql}`;

    const result = await this.pool.query(sql, compiled.values);
    return result.rowCount ?? 0;
  }

  /** Shared SELECT builder: WHERE + ORDER BY + LIMIT/OFFSET, all parameterized. */
  private buildSelect(
    defaultProjection: string,
    where: Where<T>,
    options: QueryOptions<T>
  ): { sql: string; values: unknown[] } {
    this.assertKnownWhereColumns(where as Record<string, unknown>);
    this.assertKnownOptionColumns(options);

    const projection = options.select?.length
      ? options.select.map((column) => quote(column)).join(", ")
      : defaultProjection;

    const compiled = compileWhere(where as Record<string, unknown>, quote);
    const values = [...compiled.values];

    let sql = `SELECT ${projection} FROM ${quote(this.name)}`;
    if (compiled.sql) sql += ` WHERE ${compiled.sql}`;

    const orderEntries = Object.entries(options.orderBy ?? {});
    if (orderEntries.length > 0) {
      const orderSql = orderEntries.map(([column, direction]) => {
        if (direction !== "asc" && direction !== "desc") {
          throw new QueryError(
            `orderBy direction must be "asc" or "desc", got "${String(direction)}"`
          );
        }
        return `${quote(column)} ${direction === "asc" ? "ASC" : "DESC"}`;
      });
      sql += ` ORDER BY ${orderSql.join(", ")}`;
    }

    if (options.limit !== undefined) {
      values.push(assertNonNegativeInteger(options.limit, "limit"));
      sql += ` LIMIT $${values.length}`;
    }
    if (options.offset !== undefined) {
      values.push(assertNonNegativeInteger(options.offset, "offset"));
      sql += ` OFFSET $${values.length}`;
    }

    return { sql, values };
  }

  public async findById(id: unknown): Promise<T | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${quote(this.name)} WHERE ${quote(this.primaryKey)} = $1;`,
      [id]
    );
    return (result.rows[0] as T) ?? null;
  }

  public async update(id: unknown, data: Partial<T>): Promise<T | null> {
    this.assertKnownColumns(data as Record<string, unknown>);
    const stamped = this.prepareForUpdate(data as Record<string, unknown>);
    const afterHooks = await this.hooks.runBeforeUpdate(
      id,
      stamped as Partial<T>
    );
    const entries = Object.entries(afterHooks as Record<string, unknown>);
    if (entries.length === 0) {
      return this.findById(id);
    }

    const updates = entries.map(
      ([key], index) => `${quote(key)} = $${index + 1}`
    );
    const values = entries.map(([, value]) => value);
    values.push(id);

    const result = await this.pool.query(
      `UPDATE ${quote(this.name)} SET ${updates.join(", ")} WHERE ${quote(this.primaryKey)} = $${values.length} RETURNING *;`,
      values
    );
    const row = (result.rows[0] as T) ?? null;
    if (row) await this.hooks.runAfterUpdate(row);
    return row;
  }

  public async delete(id: unknown): Promise<T | null> {
    await this.hooks.runBeforeDelete(id);
    const result = await this.pool.query(
      `DELETE FROM ${quote(this.name)} WHERE ${quote(this.primaryKey)} = $1 RETURNING *;`,
      [id]
    );
    const row = (result.rows[0] as T) ?? null;
    if (row) await this.hooks.runAfterDelete(row);
    return row;
  }
}
