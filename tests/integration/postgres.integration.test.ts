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

interface TestPost {
  id: number;
  title: string;
  userId: number;
}

const RUN = process.env.INDIGODB_INTEGRATION === "1";
const describeIntegration = RUN ? describe : describe.skip;

const WS_PORT = Number(process.env.PG_TEST_WS_PORT ?? 8091);
const TABLE = "indigodb_it_users";
const POSTS_TABLE = "indigodb_it_posts";

describeIntegration("PostgreSQL integration", () => {
  let db: IndigoDB;
  let model: BaseModel<TestUser>;
  let posts: BaseModel<TestPost>;

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
    // References TABLE, so it must be defined after it (FK target must exist).
    posts = await db.defineModel<TestPost>(POSTS_TABLE, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      title: { type: DataTypes.STRING },
      userId: { type: DataTypes.INTEGER, references: { model: TABLE } },
    });
    model.hasMany(posts, { foreignKey: "userId", as: "posts" });
    posts.belongsTo(model, { foreignKey: "userId", as: "author" });
  });

  afterAll(async () => {
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

  test("transaction commits on success and rolls back on error", async () => {
    const stamp = Date.now();
    const email = `tx-commit-${stamp}@example.com`;

    await db.transaction(async (tx) => {
      const txUsers = tx.getModel(model);
      await txUsers.create({ name: "tx_commit", email } as Partial<TestUser>);
    });
    const committed = await model.findOne({ email });
    expect(committed?.name).toBe("tx_commit");

    const rollbackEmail = `tx-rollback-${stamp}@example.com`;
    await expect(
      db.transaction(async (tx) => {
        const txUsers = tx.getModel(model);
        await txUsers.create({
          name: "tx_rollback",
          email: rollbackEmail,
        } as Partial<TestUser>);
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");

    const rolledBack = await model.findOne({ email: rollbackEmail });
    expect(rolledBack).toBeNull();

    await model.deleteMany({ email: { $like: `tx-%-${stamp}@%` } } as never);
  });

  test("relations: hasMany/belongsTo eager loading via include", async () => {
    const stamp = Date.now();
    const author = await model.create({
      name: "rel_author",
      email: `rel-${stamp}@example.com`,
    } as Partial<TestUser>);

    await posts.createMany([
      { title: "Post A", userId: (author as TestUser).id },
      { title: "Post B", userId: (author as TestUser).id },
    ] as Partial<TestPost>[]);

    const usersWithPosts = await model.findAll(
      { id: (author as TestUser).id } as never,
      { include: ["posts"] }
    );
    expect(
      (usersWithPosts[0] as unknown as { posts: TestPost[] }).posts
    ).toHaveLength(2);

    const postsWithAuthor = await posts.findAll(
      { userId: (author as TestUser).id } as never,
      { include: ["author"] }
    );
    for (const post of postsWithAuthor) {
      expect((post as unknown as { author: TestUser }).author.email).toBe(
        `rel-${stamp}@example.com`
      );
    }

    await posts.deleteMany({ userId: (author as TestUser).id } as never);
    await model.delete((author as TestUser).id);
  });

  test("redact: sensitive columns never reach real-time subscribers", async () => {
    interface Account {
      id: number;
      email: string;
      passwordHash: string;
    }
    const ACCOUNTS_TABLE = "indigodb_it_accounts";
    const accounts = await db.defineModel<Account>(
      ACCOUNTS_TABLE,
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        email: { type: DataTypes.STRING },
        passwordHash: { type: DataTypes.STRING },
      },
      { redact: ["passwordHash"] }
    );

    const events: ChangeEvent[] = [];
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.data.model === ACCOUNTS_TABLE) events.push(message.data);
    });

    const created = await accounts.create({
      email: `redact-${Date.now()}@example.com`,
      passwordHash: "s3cr3t-hash",
    } as Partial<Account>);

    await new Promise((resolve) => setTimeout(resolve, 500));
    ws.close();

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.data).not.toHaveProperty("passwordHash");
    }
    // CRUD results themselves are NOT redacted — only the broadcast is.
    expect((created as Account).passwordHash).toBe("s3cr3t-hash");

    await accounts.delete((created as Account).id);
  });
});
