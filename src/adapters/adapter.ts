import { EventEmitter } from "node:events";
import { ChangeEvent, ModelOptions, ModelSchema } from "../types";
import { BaseModel } from "../models/baseModel";

/**
 * Handed to the callback passed to `db.transaction()`. `getModel` exchanges
 * an already-`defineModel`'d instance for a clone bound to the transaction's
 * connection/session — same schema and hooks, but every query runs inside
 * the transaction and is rolled back with it on error.
 */
export interface TransactionContext {
  getModel<T>(model: BaseModel<T>): BaseModel<T>;
}

/**
 * Adapter contract for database backends. Each backend connects, creates
 * models (Factory Method) and emits `"change"` events with a uniform
 * ChangeEvent payload regardless of how the backend detects changes
 * (Postgres triggers + NOTIFY, MongoDB change streams, ...).
 */
export abstract class DatabaseAdapter extends EventEmitter {
  public abstract connect(): Promise<void>;
  public abstract disconnect(): Promise<void>;
  public abstract defineModel<T>(
    name: string,
    schema: ModelSchema,
    options?: ModelOptions
  ): Promise<BaseModel<T>>;
  /**
   * Native escape hatch. PostgreSQL: a SQL string + parameter values.
   * MongoDB: a command document (params ignored).
   */
  public abstract raw(query: unknown, params?: unknown[]): Promise<unknown>;

  /**
   * Runs `fn` inside a database transaction, committing on success and
   * rolling back if `fn` throws (the error is rethrown). PostgreSQL: a
   * dedicated pooled connection with BEGIN/COMMIT/ROLLBACK. MongoDB: a
   * ClientSession via `withTransaction` (requires a replica set).
   */
  public abstract transaction<R>(
    fn: (tx: TransactionContext) => Promise<R>
  ): Promise<R>;

  /** Per-model redaction rules, registered by defineModel() implementations. */
  private readonly redactions = new Map<string, readonly string[]>();

  /** Registers the model's redact list so emitChange() strips those columns. */
  protected trackRedaction(model: BaseModel<unknown>): void {
    if (model.redactedColumns.length > 0) {
      this.redactions.set(model.name, model.redactedColumns);
    }
  }

  protected emitChange(event: ChangeEvent): void {
    const redact = this.redactions.get(event.model);
    if (
      redact &&
      event.data !== null &&
      typeof event.data === "object" &&
      !Array.isArray(event.data)
    ) {
      const data = { ...(event.data as Record<string, unknown>) };
      for (const column of redact) {
        delete data[column];
      }
      event = { ...event, data };
    }
    this.emit("change", event);
  }
}
