import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MigrationDatabase,
  MigrationRunner,
} from "../../src/migrations/migrationRunner";
import { ConfigurationError } from "../../src/errors";

interface HistoryRecord {
  name: string;
  appliedAt: Date;
  sequence: number;
}

function makeDb(): MigrationDatabase & { records: HistoryRecord[] } {
  const records: HistoryRecord[] = [];
  return {
    records,
    defineModel: jest.fn().mockResolvedValue({
      findAll: async () => [...records],
      findOne: async () => {
        if (records.length === 0) return null;
        return [...records].sort((a, b) => b.sequence - a.sequence)[0];
      },
      create: async (data: HistoryRecord) => {
        records.push(data);
        return data;
      },
      delete: async (name: string) => {
        const index = records.findIndex((r) => r.name === name);
        if (index === -1) return null;
        const [removed] = records.splice(index, 1);
        return removed;
      },
    }),
    raw: jest.fn().mockResolvedValue(undefined),
  };
}

function writeMigration(
  dir: string,
  fileName: string,
  content = `module.exports = {
  async up(ctx) { await ctx.raw("UP"); },
  async down(ctx) { await ctx.raw("DOWN"); },
};`
): void {
  writeFileSync(join(dir, fileName), content);
}

describe("MigrationRunner", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "indigodb-migrations-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("up() applies pending migrations in filename order and records them", async () => {
    writeMigration(dir, "0002_second.js");
    writeMigration(dir, "0001_first.js");
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });

    const ran = await runner.up();

    expect(ran).toEqual(["0001_first", "0002_second"]);
    expect(db.raw).toHaveBeenCalledTimes(2);
    expect(db.records.map((r) => r.name)).toEqual([
      "0001_first",
      "0002_second",
    ]);
  });

  test("up() skips migrations already recorded in history", async () => {
    writeMigration(dir, "0001_first.js");
    writeMigration(dir, "0002_second.js");
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });

    await runner.up();
    (db.raw as jest.Mock).mockClear();
    const secondRun = await runner.up();

    expect(secondRun).toEqual([]);
    expect(db.raw).not.toHaveBeenCalled();
  });

  test("status() reports applied vs pending", async () => {
    writeMigration(dir, "0001_first.js");
    writeMigration(dir, "0002_second.js");
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });

    await runner.up();
    writeMigration(dir, "0003_third.js");

    const status = await runner.status();
    expect(status.applied).toEqual(["0001_first", "0002_second"]);
    expect(status.pending).toEqual(["0003_third"]);
  });

  test("down() reverts the most recently applied migration and removes its record", async () => {
    writeMigration(dir, "0001_first.js");
    writeMigration(dir, "0002_second.js");
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });
    await runner.up();

    const reverted = await runner.down();

    expect(reverted).toBe("0002_second");
    expect(db.records.map((r) => r.name)).toEqual(["0001_first"]);
  });

  test("down() picks the last-applied migration by sequence, not by appliedAt (which can tie)", async () => {
    writeMigration(dir, "0001_first.js");
    writeMigration(dir, "0002_second.js");
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });

    await runner.up();
    // Simulate two migrations applied within the same millisecond.
    const tiedTimestamp = new Date();
    db.records[0]!.appliedAt = tiedTimestamp;
    db.records[1]!.appliedAt = tiedTimestamp;

    const reverted = await runner.down();
    expect(reverted).toBe("0002_second");
  });

  test("down() returns null when nothing has been applied", async () => {
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });
    await expect(runner.down()).resolves.toBeNull();
  });

  test("down() throws if the migration file for the last applied entry is missing", async () => {
    writeMigration(dir, "0001_first.js");
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });
    await runner.up();

    rmSync(join(dir, "0001_first.js"));

    await expect(runner.down()).rejects.toThrow(ConfigurationError);
  });

  test("ignores non-migration files and derives names from filenames", async () => {
    writeMigration(dir, "0001_create_users.js");
    writeFileSync(join(dir, "README.md"), "not a migration");
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });

    const status = await runner.status();
    expect(status.pending).toEqual(["0001_create_users"]);
  });

  test("throws ConfigurationError for a missing migrations directory", async () => {
    const db = makeDb();
    const runner = new MigrationRunner(db, {
      directory: join(dir, "does-not-exist"),
    });
    await expect(runner.status()).rejects.toThrow(ConfigurationError);
  });

  test("throws ConfigurationError when a migration file doesn't export up/down", async () => {
    writeMigration(dir, "0001_broken.js", "module.exports = {};");
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });
    await expect(runner.status()).rejects.toThrow(ConfigurationError);
  });

  test("an explicit exported name overrides the filename-derived one", async () => {
    writeMigration(
      dir,
      "0001_x.js",
      `module.exports = {
        name: "custom_name",
        async up() {},
        async down() {},
      };`
    );
    const db = makeDb();
    const runner = new MigrationRunner(db, { directory: dir });
    const status = await runner.status();
    expect(status.pending).toEqual(["custom_name"]);
  });
});
