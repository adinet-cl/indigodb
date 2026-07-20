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
  /**
   * Emit real-time change events for this model. Defaults to true. When
   * false, no Postgres trigger is created (an existing one is dropped) and
   * no Mongo change stream is opened — changes to this model are never
   * broadcast, in-process or over WebSocket.
   */
  broadcast?: boolean;
  /**
   * Column names stripped from every ChangeEvent for this model before it is
   * emitted or broadcast — use it for password hashes, tokens, and anything
   * else that must never reach real-time subscribers. Columns must exist in
   * the schema. CRUD results are NOT redacted; this only affects change events.
   */
  redact?: string[];
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
  /**
   * TLS settings, passed through to the `pg` driver — `true`, or an object
   * like `{ rejectUnauthorized: false }` / `{ ca: "..." }`. Required by most
   * managed Postgres providers (RDS, Supabase, Neon, ...).
   */
  ssl?: boolean | Record<string, unknown>;
  /** Connection-pool tuning, passed through to `pg.Pool`. */
  pool?: {
    /** Maximum pool size. pg default: 10. */
    max?: number;
    /** Minimum idle connections kept open. */
    min?: number;
    /** Close idle connections after this many ms. */
    idleTimeoutMillis?: number;
    /** Fail connection attempts after this many ms. */
    connectionTimeoutMillis?: number;
  };
}

export interface MongoConfig {
  type: "mongodb";
  connectionString: string;
  /** Defaults to the database named in the connection string. */
  database?: string;
  /** Extra driver options passed straight to the MongoClient constructor (tls, auth, pool sizing, ...). */
  options?: Record<string, unknown>;
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
  /**
   * Set by the PostgreSQL trigger when the full row exceeded the pg_notify
   * payload limit (~8KB): `data` then carries only the primary key. Re-fetch
   * the record if you need the rest.
   */
  truncated?: boolean;
}
