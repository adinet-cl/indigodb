import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const connect = jest.fn().mockResolvedValue(undefined);
const close = jest.fn().mockResolvedValue(undefined);
const runnerUp = jest.fn().mockResolvedValue(["0001_first"]);
const runnerDown = jest.fn().mockResolvedValue("0001_first");
const runnerStatus = jest
  .fn()
  .mockResolvedValue({ applied: ["0001_first"], pending: [] });

jest.mock("../../src/indigodb", () => ({
  IndigoDB: jest.fn().mockImplementation(() => ({ connect, close })),
}));
jest.mock("../../src/migrations/migrationRunner", () => ({
  MigrationRunner: jest.fn().mockImplementation(() => ({
    up: runnerUp,
    down: runnerDown,
    status: runnerStatus,
  })),
}));

import { runCli } from "../../src/cli/migrate";
import { IndigoDB } from "../../src/indigodb";

describe("indigodb-migrate CLI", () => {
  let dir: string;
  let configPath: string;
  let logs: string[];
  const log = (message: string) => logs.push(message);

  beforeEach(() => {
    jest.clearAllMocks();
    logs = [];
    dir = mkdtempSync(join(tmpdir(), "indigodb-cli-"));
    configPath = join(dir, "indigodb.config.js");
    writeFileSync(
      configPath,
      `module.exports = { database: { type: "postgresql", database: "test" }, migrationsDir: ${JSON.stringify(join(dir, "migrations"))} };`
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("help / no command prints usage and exits 0", async () => {
    const code = await runCli([], log);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("indigodb-migrate <command>");
  });

  test("up connects, runs the migration, logs the result, and always closes", async () => {
    const code = await runCli(["up", "--config", configPath], log);
    expect(code).toBe(0);
    expect(connect).toHaveBeenCalled();
    expect(runnerUp).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(logs.join("\n")).toContain("0001_first");
  });

  test("closes the connection even when the command rejects", async () => {
    runnerUp.mockRejectedValueOnce(new Error("boom"));
    await expect(runCli(["up", "--config", configPath], log)).rejects.toThrow(
      "boom"
    );
    expect(close).toHaveBeenCalled();
  });

  test("down reports when there is nothing to revert", async () => {
    runnerDown.mockResolvedValueOnce(null);
    await runCli(["down", "--config", configPath], log);
    expect(logs.join("\n")).toContain("No migrations to revert");
  });

  test("status prints applied and pending", async () => {
    await runCli(["status", "--config", configPath], log);
    const output = logs.join("\n");
    expect(output).toContain("Applied (1)");
    expect(output).toContain("0001_first");
  });

  test("unknown command exits 1 and does not connect", async () => {
    const code = await runCli(["nope", "--config", configPath], log);
    expect(code).toBe(1);
    expect(IndigoDB).not.toHaveBeenCalled();
  });

  test("create scaffolds a migration file without connecting to a database", async () => {
    const code = await runCli(["create", "Add users", "--config", configPath], log);
    expect(code).toBe(0);
    expect(IndigoDB).not.toHaveBeenCalled();

    const migrationsDir = join(dir, "migrations");
    const files = readdirSync(migrationsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+_add_users\.js$/);
    const content = readFileSync(join(migrationsDir, files[0]!), "utf8");
    expect(content).toContain("async up(ctx)");
    expect(content).toContain("async down(ctx)");
  });

  test("create without a name prints usage and exits 1", async () => {
    const code = await runCli(["create", "--config", configPath], log);
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("Usage:");
  });

  test("throws a clear error when the config file is missing", async () => {
    await expect(
      runCli(["up", "--config", join(dir, "missing.config.js")], log)
    ).rejects.toThrow("Config file not found");
  });
});
