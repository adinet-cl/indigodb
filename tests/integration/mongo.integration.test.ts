/**
 * MongoDB integration test. Opt-in: runs only when INDIGODB_INTEGRATION=1 and
 * a live MongoDB **replica set** (required for change streams + transactions)
 * is reachable via MONGO_URL (see .env.example). Excluded from the default
 * `npm test` run by jest config.
 */
import "dotenv/config";
import { IndigoDB } from "../../src/indigodb";
import { DataTypes } from "../../src/dataTypes";
import { ChangeEvent } from "../../src/types";
import { BaseModel } from "../../src/models/baseModel";
import WebSocket from "ws";

interface TestUser {
  _id?: unknown;
  name: string;
  email: string;
}

interface TestPost {
  _id?: unknown;
  title: string;
  userId: unknown;
}

const RUN = process.env.INDIGODB_INTEGRATION === "1";
const describeIntegration = RUN ? describe : describe.skip;

const WS_PORT = Number(process.env.MONGO_TEST_WS_PORT ?? 8092);
const COLLECTION = "indigodb_it_users";
const POSTS_COLLECTION = "indigodb_it_posts";

describeIntegration("MongoDB integration", () => {
  let db: IndigoDB;
  let model: BaseModel<TestUser>;
  let posts: BaseModel<TestPost>;

  beforeAll(async () => {
    db = new IndigoDB({
      database: {
        type: "mongodb",
        connectionString:
          process.env.MONGO_URL ?? "mongodb://localhost:27017/indigodb_test",
      },
      realtime: { enabled: true, port: WS_PORT },
    });
    await db.connect();
    model = await db.defineModel<TestUser>(COLLECTION, {
      name: { type: DataTypes.STRING },
      email: { type: DataTypes.STRING, unique: true },
    });
    posts = await db.defineModel<TestPost>(POSTS_COLLECTION, {
      title: { type: DataTypes.STRING },
      userId: { type: DataTypes.STRING },
    });
    model.hasMany(posts, { foreignKey: "userId", as: "posts" });
    posts.belongsTo(model, { foreignKey: "userId", as: "author" });
  });

  afterAll(async () => {
    // Drop everything this suite created so reruns start clean.
    try {
      await model?.deleteMany({});
      await posts?.deleteMany({});
    } catch {
      // best-effort cleanup
    }
    await db?.close();
  });

  test("CRUD round-trip and change-stream notifications over WebSocket", async () => {
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
    expect((created as TestUser)._id).toBeDefined();

    const updated = await model.update((created as TestUser)._id, {
      name: "Grace",
    } as Partial<TestUser>);
    expect((updated as TestUser).name).toBe("Grace");

    const deleted = await model.delete((created as TestUser)._id);
    expect(deleted).not.toBeNull();

    // Change streams are async; give them time to flush through the gateway.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    ws.close();

    const operations = events
      .filter((e) => e.model === COLLECTION)
      .map((e) => e.operation);
    expect(operations).toEqual(
      expect.arrayContaining(["INSERT", "UPDATE", "DELETE"])
    );
  });

  test("query engine round-trip: operators, orderBy, pagination and bulk ops", async () => {
    const stamp = Date.now();

    const created = await model.createMany([
      { name: "qe_alpha", email: `qe-a-${stamp}@example.com` },
      { name: "qe_beta", email: `qe-b-${stamp}@example.com` },
      { name: "qe_gamma", email: `qe-c-${stamp}@example.com` },
    ] as Partial<TestUser>[]);
    expect(created).toHaveLength(3);

    const matched = await model.findAll(
      { name: { $like: "qe\\_%" }, email: { $like: `%-${stamp}@%` } } as never,
      { orderBy: { name: "desc" }, limit: 2 } as never
    );
    expect(matched.map((u) => u.name)).toEqual(["qe_gamma", "qe_beta"]);

    const total = await model.count({
      email: { $like: `%-${stamp}@%` },
    } as never);
    expect(total).toBe(3);

    const one = await model.findOne({
      $or: [{ name: "qe_alpha" }, { name: "does_not_exist" }],
    } as never);
    expect(one?.name).toBe("qe_alpha");

    const renamed = await model.updateMany(
      { name: { $in: ["qe_alpha", "qe_beta"] } } as never,
      { name: "qe_renamed" } as never
    );
    expect(renamed).toBe(2);

    const removed = await model.deleteMany({
      email: { $like: `%-${stamp}@%` },
    } as never);
    expect(removed).toBe(3);
  });

  test("transaction commits on success and rolls back on error", async () => {
    const stamp = Date.now();
    const email = `tx-commit-${stamp}@example.com`;

    await db.transaction(async (tx) => {
      const txUsers = tx.getModel(model);
      await txUsers.create({ name: "tx_commit", email } as Partial<TestUser>);
    });
    const committed = await model.findOne({ email } as never);
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

    const rolledBack = await model.findOne({ email: rollbackEmail } as never);
    expect(rolledBack).toBeNull();

    await model.deleteMany({ email: { $like: `tx-%-${stamp}@%` } } as never);
  });

  test("relations: hasMany/belongsTo eager loading via include", async () => {
    const stamp = Date.now();
    const author = await model.create({
      name: "rel_author",
      email: `rel-${stamp}@example.com`,
    } as Partial<TestUser>);
    // Store the raw ObjectId — this is exactly the case where identity-keyed
    // joins would break (ObjectIds deserialize as distinct instances).
    const authorId = (author as TestUser)._id;

    await posts.createMany([
      { title: "Post A", userId: authorId },
      { title: "Post B", userId: authorId },
    ] as Partial<TestPost>[]);

    const usersWithPosts = await model.findAll(
      { email: `rel-${stamp}@example.com` } as never,
      { include: ["posts"] } as never
    );
    expect(
      (usersWithPosts[0] as unknown as { posts: TestPost[] }).posts
    ).toHaveLength(2);

    const postsWithAuthor = await posts.findAll(
      { userId: authorId } as never,
      { include: ["author"] } as never
    );
    expect(postsWithAuthor).toHaveLength(2);

    await posts.deleteMany({ userId: authorId } as never);
    await model.delete((author as TestUser)._id);
  });

  test("redact: sensitive columns never reach real-time subscribers", async () => {
    interface Account {
      _id?: unknown;
      email: string;
      passwordHash: string;
    }
    const ACCOUNTS_COLLECTION = "indigodb_it_accounts";
    const accounts = await db.defineModel<Account>(
      ACCOUNTS_COLLECTION,
      {
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
      if (message.data.model === ACCOUNTS_COLLECTION) events.push(message.data);
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
    expect((created as Account).passwordHash).toBe("s3cr3t-hash");

    await accounts.delete((created as Account)._id);
  });
});
