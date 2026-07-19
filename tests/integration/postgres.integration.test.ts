/**
 * PostgreSQL integration test. Opt-in: runs only when INDIGODB_INTEGRATION=1
 * and a live PostgreSQL instance is reachable via the PG_* env vars (see
 * .env.example). Excluded from the default `npm test` run by jest config.
 */
import "dotenv/config";
import { IndigoDB } from "../../src/indigodb";
import { DataTypes } from "../../src/dataTypes";
import { ChangeEvent } from "../../src/types";
import { BaseModel } from "../../src/models/baseModel";
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
  let model: BaseModel<TestUser>;

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

  test("query engine round-trip: operators, orderBy, pagination and bulk ops", async () => {
    const users = model as unknown as {
      createMany(data: object[]): Promise<TestUser[]>;
      findAll(where?: object, options?: object): Promise<TestUser[]>;
      findOne(where?: object): Promise<TestUser | null>;
      count(where?: object): Promise<number>;
      updateMany(where: object, data: object): Promise<number>;
      deleteMany(where: object): Promise<number>;
    };
    const stamp = Date.now();

    const created = await users.createMany([
      { name: "qe_alpha", email: `qe-a-${stamp}@example.com` },
      { name: "qe_beta", email: `qe-b-${stamp}@example.com` },
      { name: "qe_gamma", email: `qe-c-${stamp}@example.com` },
    ]);
    expect(created).toHaveLength(3);

    const matched = await users.findAll(
      { name: { $like: "qe\\_%" }, email: { $like: `%-${stamp}@%` } },
      { orderBy: { name: "desc" }, limit: 2 }
    );
    expect(matched.map((u) => u.name)).toEqual(["qe_gamma", "qe_beta"]);

    const total = await users.count({ email: { $like: `%-${stamp}@%` } });
    expect(total).toBe(3);

    const one = await users.findOne({
      $or: [{ name: "qe_alpha" }, { name: "does_not_exist" }],
    });
    expect(one?.name).toBe("qe_alpha");

    const renamed = await users.updateMany(
      { name: { $in: ["qe_alpha", "qe_beta"] } },
      { name: "qe_renamed" }
    );
    expect(renamed).toBe(2);

    const removed = await users.deleteMany({
      email: { $like: `%-${stamp}@%` },
    });
    expect(removed).toBe(3);
  });
});
