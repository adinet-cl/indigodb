export const DataTypes = {
  INTEGER: "INTEGER",
  BIGINT: "BIGINT",
  FLOAT: "FLOAT",
  DOUBLE: "DOUBLE",
  DECIMAL: "DECIMAL",
  STRING: "STRING",
  TEXT: "TEXT",
  BOOLEAN: "BOOLEAN",
  DATE: "DATE",
  DATEONLY: "DATEONLY",
  UUID: "UUID",
  ENUM: "ENUM",
  BINARY: "BINARY",
  JSON: "JSON",
} as const;

export type DataType = (typeof DataTypes)[keyof typeof DataTypes];

/**
 * Base PostgreSQL type per DataType. STRING/DECIMAL/ENUM are further
 * parameterized at table-creation time (VARCHAR(n), NUMERIC(p,s), a TEXT +
 * CHECK constraint) — see PostgresModel.createTable().
 */
export const POSTGRES_TYPE_MAP: Record<DataType, string> = {
  INTEGER: "INTEGER",
  BIGINT: "BIGINT",
  FLOAT: "REAL",
  DOUBLE: "DOUBLE PRECISION",
  DECIMAL: "NUMERIC",
  STRING: "VARCHAR(255)",
  TEXT: "TEXT",
  BOOLEAN: "BOOLEAN",
  DATE: "TIMESTAMP",
  DATEONLY: "DATE",
  UUID: "UUID",
  ENUM: "TEXT",
  BINARY: "BYTEA",
  JSON: "JSONB",
};
