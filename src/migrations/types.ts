export interface MigrationContext {
  /**
   * Native escape hatch, same contract as `IndigoDB.raw()`: a SQL string +
   * params on PostgreSQL, a command document on MongoDB.
   */
  raw(query: unknown, params?: unknown[]): Promise<unknown>;
}

export interface Migration {
  /** Unique identifier, derived from the filename when not exported explicitly. */
  name: string;
  up(ctx: MigrationContext): Promise<void>;
  down(ctx: MigrationContext): Promise<void>;
}

export interface MigrationStatus {
  /** Names of migrations already recorded in the history store, in applied order. */
  applied: string[];
  /** Names of migration files with no matching history record, in filename order. */
  pending: string[];
}
