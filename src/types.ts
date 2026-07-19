import type { Logger } from "./logger";
import type { DataType } from "./dataTypes";

export interface ColumnDefinition {
  type: DataType;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unique?: boolean;
}

export interface ModelSchema {
  [column: string]: ColumnDefinition;
}

export interface PostgresConfig {
  type: "postgresql";
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Takes precedence over the individual connection fields when provided. */
  connectionString?: string;
}

export interface MongoConfig {
  type: "mongodb";
  connectionString: string;
  /** Defaults to the database named in the connection string. */
  database?: string;
}

export type DatabaseConfig = PostgresConfig | MongoConfig;

export interface RealtimeConfig {
  enabled: boolean;
  /** WebSocket server port. Defaults to 8080. */
  port?: number;
}

export interface Config {
  database: DatabaseConfig;
  /** Real-time updates are opt-in: omit this to skip starting any server. */
  realtime?: RealtimeConfig;
  logger?: Logger;
}

export type ChangeOperation = "INSERT" | "UPDATE" | "DELETE";

export interface ChangeEvent<T = unknown> {
  model: string;
  operation: ChangeOperation;
  data: T;
}
