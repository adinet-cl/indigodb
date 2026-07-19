export const DataTypes = {
  INTEGER: "INTEGER",
  STRING: "STRING",
  FLOAT: "FLOAT",
  BOOLEAN: "BOOLEAN",
  DATE: "DATE",
  TEXT: "TEXT",
  JSON: "JSON",
} as const;

export type DataType = (typeof DataTypes)[keyof typeof DataTypes];

export const POSTGRES_TYPE_MAP: Record<DataType, string> = {
  INTEGER: "INTEGER",
  STRING: "VARCHAR(255)",
  FLOAT: "REAL",
  BOOLEAN: "BOOLEAN",
  DATE: "TIMESTAMP",
  TEXT: "TEXT",
  JSON: "JSONB",
};
