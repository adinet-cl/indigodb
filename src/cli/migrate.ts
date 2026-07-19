#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { IndigoDB } from "../indigodb";
import { MigrationRunner } from "../migrations/migrationRunner";
import { DatabaseConfig } from "../types";

interface CliConfig {
  database: DatabaseConfig;
  migrationsDir?: string;
}

const HELP_TEXT = `indigodb-migrate <command> [options]

Commands:
  up                Apply every pending migration
  down              Revert the most recently applied migration
  status            List applied and pending migrations
  create <name>     Scaffold a new migration file

Options:
  --config <path>   Path to the config file (default: ./indigodb.config.js)

The config file is a CommonJS module exporting:
  module.exports = {
    database: { type: "postgresql", host: "localhost", ... },
    migrationsDir: "./migrations", // optional, defaults to "./migrations"
  };
`;

function loadConfig(configPath: string): CliConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: "${configPath}"`);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = require(configPath);
  return (loaded.default ?? loaded) as CliConfig;
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function scaffoldMigration(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const fileName = `${Date.now()}_${slugify(name) || "migration"}.js`;
  const filePath = join(directory, fileName);
  writeFileSync(
    filePath,
    `/** @type {import("@adinet/indigodb").Migration} */
module.exports = {
  async up(ctx) {
    // await ctx.raw("CREATE TABLE ...");
  },
  async down(ctx) {
    // await ctx.raw("DROP TABLE ...");
  },
};
`
  );
  return filePath;
}

const KNOWN_COMMANDS = ["up", "down", "status", "create"] as const;

/** Splits `--config <path>` out of argv, leaving only positional arguments. */
function extractArgs(argv: string[]): { positional: string[]; configPath: string } {
  const positional: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") {
      configPath = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i]!);
    }
  }
  return {
    positional,
    configPath: configPath
      ? resolve(configPath)
      : resolve(process.cwd(), "indigodb.config.js"),
  };
}

export async function runCli(
  argv: string[],
  log: (message: string) => void = console.log
): Promise<number> {
  const { positional, configPath } = extractArgs(argv);
  const [command, ...rest] = positional;

  if (!command || command === "help" || command === "--help") {
    log(HELP_TEXT);
    return 0;
  }

  if (!KNOWN_COMMANDS.includes(command as (typeof KNOWN_COMMANDS)[number])) {
    log(`Unknown command "${command}".\n\n${HELP_TEXT}`);
    return 1;
  }

  if (command === "create") {
    const name = rest[0];
    if (!name) {
      log("Usage: indigodb-migrate create <name>");
      return 1;
    }
    const config = loadConfig(configPath);
    const directory = resolve(config.migrationsDir ?? "./migrations");
    const filePath = scaffoldMigration(directory, name);
    log(`Created ${filePath}`);
    return 0;
  }

  const config = loadConfig(configPath);
  const db = new IndigoDB({ database: config.database });
  await db.connect();
  const runner = new MigrationRunner(db, {
    directory: resolve(config.migrationsDir ?? "./migrations"),
  });

  try {
    switch (command) {
      case "up": {
        const ran = await runner.up();
        log(ran.length ? `Applied: ${ran.join(", ")}` : "Already up to date.");
        return 0;
      }
      case "down": {
        const reverted = await runner.down();
        log(reverted ? `Reverted: ${reverted}` : "No migrations to revert.");
        return 0;
      }
      case "status": {
        const status = await runner.status();
        log(`Applied (${status.applied.length}): ${status.applied.join(", ") || "-"}`);
        log(`Pending (${status.pending.length}): ${status.pending.join(", ") || "-"}`);
        return 0;
      }
      default:
        return 1;
    }
  } finally {
    await db.close();
  }
}

/* istanbul ignore next -- exercised via the compiled bin, not unit tests */
if (require.main === module) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
