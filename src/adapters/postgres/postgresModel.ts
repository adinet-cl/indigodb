import type { Pool } from "pg";
import { BaseModel } from "../../models/baseModel";
import { ModelSchema } from "../../types";
import { POSTGRES_TYPE_MAP } from "../../dataTypes";
import { UnsupportedTypeError } from "../../errors";
import { NOTIFICATION_CHANNEL } from "./constants";

/** Minimal query surface the model needs; satisfied by pg.Pool. */
export interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Double-quotes an identifier so reserved words (user, order, end, ...) and
 * case-sensitive names are valid SQL. The name is already validated by
 * assertValidIdentifier, so it cannot contain a quote to escape.
 */
function quote(identifier: string): string {
  return `"${identifier}"`;
}

export class PostgresModel<T> extends BaseModel<T> {
  private readonly pool: QueryExecutor;

  constructor(name: string, schema: ModelSchema, pool: QueryExecutor | Pool) {
    // No default primary key: Postgres schemas must declare one explicitly.
    super(name, schema);
    this.pool = pool as QueryExecutor;
  }

  /** Creates the table and change-notification triggers. Must complete before CRUD. */
  public async init(): Promise<void> {
    await this.createTable();
    await this.setupTriggers();
  }

  private async createTable(): Promise<void> {
    const columns: string[] = [];
    for (const [columnName, columnProps] of Object.entries(this.schema)) {
      const sqlType = POSTGRES_TYPE_MAP[columnProps.type];
      if (!sqlType) {
        throw new UnsupportedTypeError(columnProps.type);
      }
      let columnDef = `${quote(columnName)} ${sqlType}`;
      if (columnProps.autoIncrement) columnDef += " GENERATED ALWAYS AS IDENTITY";
      if (columnProps.primaryKey) columnDef += " PRIMARY KEY";
      if (columnProps.unique) columnDef += " UNIQUE";
      columns.push(columnDef);
    }

    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${quote(this.name)} (${columns.join(", ")});`
    );
  }

  private async setupTriggers(): Promise<void> {
    const functionName = quote(`notify_${this.name}_change`);
    const triggerName = quote(`${this.name}_change_trigger`);
    const table = quote(this.name);

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
        payload := json_build_object(
          'model', '${this.name}',
          'operation', TG_OP,
          'data', row_to_json(record)
        )::text;
        PERFORM pg_notify('${NOTIFICATION_CHANNEL}', payload);
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

  public async create(data: Partial<T>): Promise<T> {
    const entries = Object.entries(data as Record<string, unknown>);
    this.assertKnownColumns(data as Record<string, unknown>);

    if (entries.length === 0) {
      const result = await this.pool.query(
        `INSERT INTO ${quote(this.name)} DEFAULT VALUES RETURNING *;`
      );
      return result.rows[0] as T;
    }

    const columns = entries.map(([key]) => quote(key)).join(", ");
    const values = entries.map(([, value]) => value);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

    const result = await this.pool.query(
      `INSERT INTO ${quote(this.name)} (${columns}) VALUES (${placeholders}) RETURNING *;`,
      values
    );
    return result.rows[0] as T;
  }

  public async findAll(criteria: Partial<T> = {}): Promise<T[]> {
    this.assertKnownColumns(criteria as Record<string, unknown>);

    const entries = Object.entries(criteria as Record<string, unknown>);
    let query = `SELECT * FROM ${quote(this.name)}`;
    const values: unknown[] = [];

    if (entries.length > 0) {
      const whereClauses = entries.map(([key, value], index) => {
        values.push(value);
        return `${quote(key)} = $${index + 1}`;
      });
      query += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    const result = await this.pool.query(query, values);
    return result.rows as T[];
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

    const entries = Object.entries(data as Record<string, unknown>);
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
    return (result.rows[0] as T) ?? null;
  }

  public async delete(id: unknown): Promise<T | null> {
    const result = await this.pool.query(
      `DELETE FROM ${quote(this.name)} WHERE ${quote(this.primaryKey)} = $1 RETURNING *;`,
      [id]
    );
    return (result.rows[0] as T) ?? null;
  }
}
