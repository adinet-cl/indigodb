import type { IncomingMessage } from "node:http";
import type { Logger } from "./logger";
import type { DataType } from "./dataTypes";

export interface ColumnDefinition {
  type: DataType;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unique?: boolean;
  /** Rejects create() calls missing this column (after defaults are applied). */
  required?: boolean;
  /** Static value or a factory invoked per row when the column is omitted on create(). */
  default?: unknown | (() => unknown);
  /** Creates a non-unique index on this column. */
  index?: boolean;
  /**
   * Foreign key target. PostgreSQL: adds a `REFERENCES` constraint — the
   * referenced table must already exist, so define the target model first.
   * MongoDB: documentation only, not enforced (no native FK constraints).
   */
  references?: { model: string; column?: string };
  /** STRING only: VARCHAR(length). Defaults to 255. Must be a positive integer. */
  length?: number;
  /** DECIMAL only: NUMERIC(precision, scale). Omit both for an unconstrained NUMERIC. */
  precision?: number;
  /** DECIMAL only: paired with `precision`; the number of digits after the decimal point. */
  scale?: number;
  /** ENUM only: the allowed values. Required for ENUM columns; create()/update() reject anything else. */
  values?: string[];
}

export interface ModelSchema {
  [column: string]: ColumnDefinition;
}

export interface ModelOptions {
  /**
   * Adds and manages `createdAt`/`updatedAt` DATE columns automatically:
   * set on create(), refreshed on update(). Defaults to false.
   */
  timestamps?: boolean;
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
  /**
   * Called for every incoming WebSocket connection with the raw HTTP upgrade
   * request (inspect headers, query string, cookies, ...). Return/resolve
   * `false` to refuse the connection. Omit to accept every connection.
   */
  authenticate?: (request: IncomingMessage) => boolean | Promise<boolean>;
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
