import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { BaseModel } from "../models/baseModel";
import { DataTypes } from "../dataTypes";
import { ModelOptions, ModelSchema } from "../types";
import { ConfigurationError } from "../errors";
import { Migration, MigrationContext, MigrationStatus } from "./types";

/** The subset of IndigoDB that MigrationRunner depends on — kept minimal for easy testing. */
export interface MigrationDatabase {
  defineModel<T>(
    name: string,
    schema: ModelSchema,
    options?: ModelOptions
  ): Promise<BaseModel<T>>;
  raw(query: unknown, params?: unknown[]): Promise<unknown>;
}

export interface MigrationRunnerOptions {
  /** Directory containing migration files (.js/.cjs), loaded and sorted by filename. */
  directory: string;
  /** History table/collection name. Defaults to "indigodb_migrations". */
  tableName?: string;
}

interface MigrationRecord {
  name: string;
  appliedAt: Date;
  /**
   * Monotonic application order. `appliedAt` alone isn't reliable for
   * ordering: DATE columns can have coarser resolution than the time it
   * takes to apply several migrations in one `up()` run, so ties are
   * possible — `sequence` never ties.
   */
  sequence: number;
}

const MIGRATION_FILE_PATTERN = /\.(c?js)$/;

/**
 * Applies/reverts migrations and tracks which ones ran in a history
 * table/collection defined the same way any other model is — so it works
 * identically on both backends with no backend-specific bookkeeping code.
 */
export class MigrationRunner {
  private readonly directory: string;
  private readonly tableName: string;
  private history?: BaseModel<MigrationRecord>;

  constructor(
    private readonly db: MigrationDatabase,
    options: MigrationRunnerOptions
  ) {
    this.directory = options.directory;
    this.tableName = options.tableName ?? "indigodb_migrations";
  }

  private async getHistory(): Promise<BaseModel<MigrationRecord>> {
    if (!this.history) {
      this.history = await this.db.defineModel<MigrationRecord>(
        this.tableName,
        {
          name: { type: DataTypes.STRING, primaryKey: true },
          appliedAt: { type: DataTypes.DATE, required: true },
          sequence: { type: DataTypes.INTEGER, required: true },
        }
      );
    }
    return this.history;
  }

  private loadMigrations(): Migration[] {
    let files: string[];
    try {
      files = readdirSync(this.directory);
    } catch {
      throw new ConfigurationError(
        `Migrations directory not found: "${this.directory}"`
      );
    }

    return files
      .filter((file) => MIGRATION_FILE_PATTERN.test(file))
      .sort()
      .map((file) => {
        const mod = require(join(this.directory, file)) as Partial<Migration>;
        if (typeof mod.up !== "function" || typeof mod.down !== "function") {
          throw new ConfigurationError(
            `Migration "${file}" must export up() and down() functions`
          );
        }
        return {
          name: mod.name ?? basename(file, extname(file)),
          up: mod.up,
          down: mod.down,
        } as Migration;
      });
  }

  private context(): MigrationContext {
    return { raw: (query, params) => this.db.raw(query, params) };
  }

  public async status(): Promise<MigrationStatus> {
    const history = await this.getHistory();
    const applied = (await history.findAll()).map((r) => r.name);
    const all = this.loadMigrations().map((m) => m.name);
    return { applied, pending: all.filter((name) => !applied.includes(name)) };
  }

  /** Applies every pending migration, in filename order. Returns the names that ran. */
  public async up(): Promise<string[]> {
    const history = await this.getHistory();
    const existing = await history.findAll();
    const applied = new Set(existing.map((r) => r.name));
    let sequence = existing.reduce((max, r) => Math.max(max, r.sequence), 0);
    const ctx = this.context();

    const ran: string[] = [];
    for (const migration of this.loadMigrations()) {
      if (applied.has(migration.name)) continue;
      await migration.up(ctx);
      sequence += 1;
      await history.create({
        name: migration.name,
        appliedAt: new Date(),
        sequence,
      } as Partial<MigrationRecord>);
      ran.push(migration.name);
    }
    return ran;
  }

  /** Reverts the most recently applied migration. Returns its name, or null if none applied. */
  public async down(): Promise<string | null> {
    const history = await this.getHistory();
    const last = await history.findOne({}, { orderBy: { sequence: "desc" } });
    if (!last) return null;

    const migration = this.loadMigrations().find((m) => m.name === last.name);
    if (!migration) {
      throw new ConfigurationError(
        `Cannot revert "${last.name}": its migration file was not found in "${this.directory}"`
      );
    }

    await migration.down(this.context());
    await history.delete(last.name);
    return last.name;
  }
}
