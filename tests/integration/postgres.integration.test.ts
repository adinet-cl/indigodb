/**
 * PostgreSQL integration test. Opt-in: runs only when INDIGODB_INTEGRATION=1
 * and a live PostgreSQL instance is reachable via the PG_* env vars (see
 * .env.example). Excluded from the default `npm test` run by jest config.
 */
import "dotenv/config";
import { IndigoDB } from "../../src/indigodb";
import { DataTypes } from "../../src/dataTypes";
import { ChangeEvent } from "../../src/types";
import WebSocket from "ws";

interface TestUser {
  id: number;
  name: string;
  email: string;
}

const RUN = process.env.INDIGODB_INTEGRATION === "1";
const describeIntegration = RUN ? describe : describe.skip;

const WS_PORT = Number(process.env.PG_TEST_WS_PORT ?? 8091);
const TABLE = "indigodb_it_users";

describeIntegration("PostgreSQL integration", () => {
  let db: IndigoDB;
  let model: Awaited<ReturnType<IndigoDB["defineModel"]>>;

  beforeAll(async () => {
    db = new IndigoDB({
      database: {
        type: "postgresql",
        host: process.env.PG_HOST ?? "localhost",
        port: Number(process.env.PG_PORT ?? 5432),
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        database: process.env.PG_DATABASE,
      },
      realtime: { enabled: true, port: WS_PORT },
    });
    await db.connect();
    model = await db.defineModel<TestUser>(TABLE, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING },
      email: { type: DataTypes.STRING, unique: true },
    });
  });

  afterAll(async () => {
    // Best-effort cleanup, then close everything so the process exits cleanly.
    const anyModel = model as unknown as {
      create: (d: Partial<TestUser>) => Promise<TestUser>;
    };
    void anyModel;
    await db?.close();
  });

  test("CRUD round-trip and real-time notifications over WebSocket", async () => {
    const events: ChangeEvent[] = [];
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      events.push(message.data);
    });

    const created = await model.create({
      name: "Ada",
      email: `ada-${Date.now()}@example.com`,
    } as Partial<TestUser>);
    expect((created as TestUser).id).toBeDefined();

    const updated = await model.update((created as TestUser).id, {
      name: "Grace",
    } as Partial<TestUser>);
    expect((updated as TestUser).name).toBe("Grace");

    const deleted = await model.delete((created as TestUser).id);
    expect(deleted).not.toBeNull();

    // Give the trigger → NOTIFY → LISTEN → broadcast pipeline time to flush.
    await new Promise((resolve) => setTimeout(resolve, 500));
    ws.close();

    const operations = events.map((e) => e.operation);
    expect(operations).toEqual(
      expect.arrayContaining(["INSERT", "UPDATE", "DELETE"])
    );
  });
});
