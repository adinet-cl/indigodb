import { EventEmitter } from "node:events";
import { ChangeEvent, ModelOptions, ModelSchema } from "../types";
import { BaseModel } from "../models/baseModel";

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

  protected emitChange(event: ChangeEvent): void {
    this.emit("change", event);
  }
}
