import { PostgresModel } from "../../src/adapters/postgres/postgresModel";
import { DataTypes } from "../../src/dataTypes";
import {
  ConfigurationError,
  InvalidIdentifierError,
  QueryError,
  UnknownColumnError,
  UnsupportedTypeError,
  ValidationError,
} from "../../src/errors";
import { ModelSchema } from "../../src/types";

interface User {
  id: number;
  name: string;
  email: string;
}

const userSchema: ModelSchema = {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING },
  email: { type: DataTypes.STRING, unique: true },
};

function makePool(rows: unknown[] = []) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe("PostgresModel", () => {
  test("requires a primaryKey column in the schema", () => {
    expect(
      () =>
        new PostgresModel(
          "users",
          { name: { type: DataTypes.STRING } },
          makePool()
        )
    ).toThrow(ConfigurationError);
  });

  test("rejects invalid table and column names", () => {
    expect(
      () => new PostgresModel("users; DROP TABLE users", userSchema, makePool())
    ).toThrow(InvalidIdentifierError);
    expect(
      () =>
        new PostgresModel(
          "users",
          { "bad name": { type: DataTypes.STRING, primaryKey: true } },
          makePool()
        )
    ).toThrow(InvalidIdentifierError);
  });

  test("init creates table with mapped types and sets up triggers", async () => {
    const pool = makePool();
    const model = new PostgresModel<User>("users", userSchema, pool);
    await model.init();

    const createTableSql = pool.query.mock.calls[0][0] as string;
    expect(createTableSql).toContain('CREATE TABLE IF NOT EXISTS "users"');
    expect(createTableSql).toContain(
      '"id" INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
    );
    expect(createTableSql).toContain('"name" VARCHAR(255)');
    expect(createTableSql).toContain('"email" VARCHAR(255) UNIQUE');

    const functionSql = pool.query.mock.calls[1][0] as string;
    expect(functionSql).toContain('"notify_users_change"');
    expect(functionSql).toContain("pg_notify('indigodb_changes'");

    const triggerSql = pool.query.mock.calls[2][0] as string;
    expect(triggerSql).toContain('"users_change_trigger"');
    expect(triggerSql).toContain('ON "users"');
  });

  test("quotes identifiers so reserved words are valid SQL", async () => {
    const pool = makePool();
    // "order" and "end" are reserved words; unquoted they break CREATE TABLE.
    const model = new PostgresModel(
      "order",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        end: { type: DataTypes.DATE },
      },
      pool
    );
    await model.init();
    const createTableSql = pool.query.mock.calls[0][0] as string;
    expect(createTableSql).toContain('CREATE TABLE IF NOT EXISTS "order"');
    expect(createTableSql).toContain('"end" TIMESTAMP');
  });

  test("init throws for unsupported data types", async () => {
    const schema = {
      id: { type: "GEOMETRY" as never, primaryKey: true },
    };
    const model = new PostgresModel("shapes", schema, makePool());
    await expect(model.init()).rejects.toThrow(UnsupportedTypeError);
  });

  test("create builds a parameterized INSERT", async () => {
    const row = { id: 1, name: "Ada", email: "ada@example.com" };
    const pool = makePool([row]);
    const model = new PostgresModel<User>("users", userSchema, pool);

    const result = await model.create({
      name: "Ada",
      email: "ada@example.com",
    });

    expect(pool.query).toHaveBeenCalledWith(
      'INSERT INTO "users" ("name", "email") VALUES ($1, $2) RETURNING *;',
      ["Ada", "ada@example.com"]
    );
    expect(result).toEqual(row);
  });

  test("create rejects columns not in the schema", async () => {
    const model = new PostgresModel<User>("users", userSchema, makePool());
    await expect(
      model.create({ "name) VALUES ('x'); --": "boom" } as never)
    ).rejects.toThrow(UnknownColumnError);
  });

  test("findAll without criteria selects everything", async () => {
    const pool = makePool([]);
    const model = new PostgresModel<User>("users", userSchema, pool);
    await model.findAll();
    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM "users"', []);
  });

  test("findAll builds parameterized WHERE clauses", async () => {
    const pool = makePool([]);
    const model = new PostgresModel<User>("users", userSchema, pool);
    await model.findAll({ name: "Ada", email: "ada@example.com" });
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT * FROM "users" WHERE "name" = $1 AND "email" = $2',
      ["Ada", "ada@example.com"]
    );
  });

  test("findAll rejects unknown criteria keys", async () => {
    const model = new PostgresModel<User>("users", userSchema, makePool());
    await expect(model.findAll({ "1=1; --": "x" } as never)).rejects.toThrow(
      UnknownColumnError
    );
  });

  test("findById/update/delete use the schema primary key", async () => {
    const row = { id: 7, name: "Ada", email: "ada@example.com" };
    const pool = makePool([row]);
    const model = new PostgresModel<User>("users", userSchema, pool);

    await model.findById(7);
    expect(pool.query).toHaveBeenLastCalledWith(
      'SELECT * FROM "users" WHERE "id" = $1;',
      [7]
    );

    await model.update(7, { name: "Grace" });
    expect(pool.query).toHaveBeenLastCalledWith(
      'UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING *;',
      ["Grace", 7]
    );

    await model.delete(7);
    expect(pool.query).toHaveBeenLastCalledWith(
      'DELETE FROM "users" WHERE "id" = $1 RETURNING *;',
      [7]
    );
  });

  test("update with empty data returns findById result without updating", async () => {
    const row = { id: 7, name: "Ada", email: "ada@example.com" };
    const pool = makePool([row]);
    const model = new PostgresModel<User>("users", userSchema, pool);

    const result = await model.update(7, {});
    expect(result).toEqual(row);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain("SELECT");
  });

  test("findById returns null when no row matches", async () => {
    const model = new PostgresModel<User>("users", userSchema, makePool([]));
    await expect(model.findById(99)).resolves.toBeNull();
  });

  test("findAll supports operators, orderBy, limit and offset", async () => {
    const pool = makePool([]);
    const model = new PostgresModel<User>("users", userSchema, pool);

    await model.findAll(
      { name: { $like: "A%" }, id: { $gte: 10 } },
      { orderBy: { name: "asc", id: "desc" }, limit: 20, offset: 40 }
    );

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT * FROM "users" WHERE "name" LIKE $1 AND "id" >= $2 ORDER BY "name" ASC, "id" DESC LIMIT $3 OFFSET $4',
      ["A%", 10, 20, 40]
    );
  });

  test("findAll select projects only the requested columns", async () => {
    const pool = makePool([]);
    const model = new PostgresModel<User>("users", userSchema, pool);
    await model.findAll({}, { select: ["id", "name"] });
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT "id", "name" FROM "users"',
      []
    );
  });

  test("findAll rejects unknown columns in where, orderBy and select", async () => {
    const model = new PostgresModel<User>("users", userSchema, makePool());
    await expect(model.findAll({ "evil; --": 1 } as never)).rejects.toThrow(
      UnknownColumnError
    );
    await expect(
      model.findAll({}, { orderBy: { "evil; --": "asc" } as never })
    ).rejects.toThrow(UnknownColumnError);
    await expect(
      model.findAll({}, { select: ["evil; --"] as never })
    ).rejects.toThrow(UnknownColumnError);
  });

  test("findAll validates $or branches too", async () => {
    const model = new PostgresModel<User>("users", userSchema, makePool());
    await expect(
      model.findAll({ $or: [{ "evil; --": 1 }] } as never)
    ).rejects.toThrow(UnknownColumnError);
  });

  test("findOne applies limit 1 and unwraps the row", async () => {
    const row = { id: 1, name: "Ada", email: "a@x.com" };
    const pool = makePool([row]);
    const model = new PostgresModel<User>("users", userSchema, pool);

    const result = await model.findOne({ name: "Ada" });

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT * FROM "users" WHERE "name" = $1 LIMIT $2',
      ["Ada", 1]
    );
    expect(result).toEqual(row);
  });

  test("count issues COUNT(*) and returns a number", async () => {
    const pool = makePool([{ count: 7 }]);
    const model = new PostgresModel<User>("users", userSchema, pool);

    const total = await model.count({ id: { $gt: 0 } });

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT COUNT(*)::int AS count FROM "users" WHERE "id" > $1',
      [0]
    );
    expect(total).toBe(7);
  });

  test("exists uses SELECT 1 LIMIT 1", async () => {
    const pool = makePool([{ one: 1 }]);
    const model = new PostgresModel<User>("users", userSchema, pool);

    await expect(model.exists({ name: "Ada" })).resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT 1 AS one FROM "users" WHERE "name" = $1 LIMIT $2',
      ["Ada", 1]
    );

    const emptyModel = new PostgresModel<User>(
      "users",
      userSchema,
      makePool([])
    );
    await expect(emptyModel.exists()).resolves.toBe(false);
  });

  test("createMany builds a single multi-row INSERT", async () => {
    const rows = [
      { id: 1, name: "Ada", email: "a@x.com" },
      { id: 2, name: "Bob", email: "b@x.com" },
    ];
    const pool = makePool(rows);
    const model = new PostgresModel<User>("users", userSchema, pool);

    const result = await model.createMany([
      { name: "Ada", email: "a@x.com" },
      { name: "Bob", email: "b@x.com" },
    ]);

    expect(pool.query).toHaveBeenCalledWith(
      'INSERT INTO "users" ("name", "email") VALUES ($1, $2), ($3, $4) RETURNING *;',
      ["Ada", "a@x.com", "Bob", "b@x.com"]
    );
    expect(result).toEqual(rows);
  });

  test("createMany rejects rows with mismatched columns and empty input", async () => {
    const model = new PostgresModel<User>("users", userSchema, makePool());
    await expect(
      model.createMany([{ name: "Ada" }, { email: "b@x.com" }])
    ).rejects.toThrow(QueryError);
    await expect(model.createMany([])).resolves.toEqual([]);
  });

  test("updateMany compiles SET before WHERE and returns rowCount", async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 3 }),
    };
    const model = new PostgresModel<User>("users", userSchema, pool);

    const affected = await model.updateMany(
      { id: { $in: [1, 2, 3] } },
      { name: "Renamed" }
    );

    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE "users" SET "name" = $1 WHERE "id" = ANY($2)',
      ["Renamed", [1, 2, 3]]
    );
    expect(affected).toBe(3);
  });

  test("deleteMany with empty where deletes all and returns rowCount", async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 9 }),
    };
    const model = new PostgresModel<User>("users", userSchema, pool);

    const removed = await model.deleteMany({});

    expect(pool.query).toHaveBeenCalledWith('DELETE FROM "users"', []);
    expect(removed).toBe(9);
  });

  test("limit/offset must be non-negative integers", async () => {
    const model = new PostgresModel<User>("users", userSchema, makePool());
    await expect(model.findAll({}, { limit: -1 })).rejects.toThrow(QueryError);
    await expect(model.findAll({}, { offset: 1.5 })).rejects.toThrow(
      QueryError
    );
  });
});

describe("PostgresModel schema completeness", () => {
  interface Account {
    id: number;
    email: string;
    plan: string;
    createdAt?: Date;
    updatedAt?: Date;
  }

  const accountSchema: ModelSchema = {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: {
      type: DataTypes.STRING,
      required: true,
      unique: true,
      index: true,
    },
    plan: { type: DataTypes.STRING, default: "free" },
  };

  test("createTable adds NOT NULL for required columns", async () => {
    const pool = makePool();
    const model = new PostgresModel<Account>("accounts", accountSchema, pool);
    await model.init();

    const createTableSql = pool.query.mock.calls[0][0] as string;
    expect(createTableSql).toContain('"email" VARCHAR(255) UNIQUE NOT NULL');
  });

  test("init creates a non-unique index only for index:true, non-unique columns", async () => {
    const pool = makePool();
    const model = new PostgresModel<Account>("accounts", accountSchema, pool);
    await model.init();

    // email is unique, so no separate non-unique index statement is issued.
    const indexCalls = pool.query.mock.calls
      .map((call) => call[0] as string)
      .filter((sql) => sql.includes("CREATE INDEX"));
    expect(indexCalls).toHaveLength(0);
  });

  test("init creates a non-unique index for index:true columns without unique", async () => {
    const schema: ModelSchema = {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      status: { type: DataTypes.STRING, index: true },
    };
    const pool = makePool();
    const model = new PostgresModel("statuses", schema, pool);
    await model.init();

    const indexSql = pool.query.mock.calls
      .map((call) => call[0] as string)
      .find((sql) => sql.includes("CREATE INDEX"));
    expect(indexSql).toContain(
      'CREATE INDEX IF NOT EXISTS "statuses_status_idx"'
    );
    expect(indexSql).toContain('ON "statuses" ("status")');
  });

  test("create applies default values for missing columns", async () => {
    const pool = makePool([{ id: 1, email: "a@x.com", plan: "free" }]);
    const model = new PostgresModel<Account>("accounts", accountSchema, pool);

    await model.create({ email: "a@x.com" });

    expect(pool.query).toHaveBeenCalledWith(
      'INSERT INTO "accounts" ("email", "plan") VALUES ($1, $2) RETURNING *;',
      ["a@x.com", "free"]
    );
  });

  test("create throws ValidationError when a required column is missing", async () => {
    const pool = makePool();
    const model = new PostgresModel<Account>("accounts", accountSchema, pool);
    await expect(model.create({ plan: "pro" })).rejects.toThrow(
      ValidationError
    );
  });

  test("timestamps: create stamps createdAt/updatedAt and update refreshes updatedAt", async () => {
    const pool = makePool([{ id: 1 }]);
    const model = new PostgresModel<Account>("accounts", accountSchema, pool, {
      timestamps: true,
    });

    await model.create({ email: "a@x.com" });
    const insertSql = pool.query.mock.calls[0][0] as string;
    const insertValues = pool.query.mock.calls[0][1] as unknown[];
    expect(insertSql).toContain('"createdAt"');
    expect(insertSql).toContain('"updatedAt"');
    expect(insertValues.some((v) => v instanceof Date)).toBe(true);

    await model.update(1, { plan: "pro" });
    const updateSql = pool.query.mock.calls[1][0] as string;
    expect(updateSql).toContain('"updatedAt" = $');
  });

  test("hooks: beforeCreate can transform the payload, afterCreate observes the record", async () => {
    const row = { id: 1, email: "a@x.com", plan: "free" };
    const pool = makePool([row]);
    const model = new PostgresModel<Account>("accounts", accountSchema, pool);

    const afterCreateCalls: Account[] = [];
    model.hooks.beforeCreate((data) => ({
      email: (data.email as string).toLowerCase(),
    }));
    model.hooks.afterCreate((record) => {
      afterCreateCalls.push(record);
    });

    await model.create({ email: "A@X.COM" });

    const insertValues = pool.query.mock.calls[0][1] as unknown[];
    expect(insertValues).toContain("a@x.com");
    expect(afterCreateCalls).toEqual([row]);
  });

  test("hooks: beforeDelete/afterDelete run around delete()", async () => {
    const row = { id: 1, email: "a@x.com", plan: "free" };
    const pool = makePool([row]);
    const model = new PostgresModel<Account>("accounts", accountSchema, pool);

    const events: string[] = [];
    model.hooks.beforeDelete((id) => {
      events.push(`before:${id}`);
    });
    model.hooks.afterDelete((record) => {
      events.push(`after:${record.id}`);
    });

    await model.delete(1);
    expect(events).toEqual(["before:1", "after:1"]);
  });

  test("createMany applies defaults per row and skips hooks", async () => {
    const rows = [
      { id: 1, email: "a@x.com", plan: "free" },
      { id: 2, email: "b@x.com", plan: "free" },
    ];
    const pool = makePool(rows);
    const model = new PostgresModel<Account>("accounts", accountSchema, pool);
    const beforeCreateCalls: unknown[] = [];
    model.hooks.beforeCreate((data) => {
      beforeCreateCalls.push(data);
    });

    await model.createMany([{ email: "a@x.com" }, { email: "b@x.com" }]);

    expect(pool.query).toHaveBeenCalledWith(
      'INSERT INTO "accounts" ("email", "plan") VALUES ($1, $2), ($3, $4) RETURNING *;',
      ["a@x.com", "free", "b@x.com", "free"]
    );
    expect(beforeCreateCalls).toHaveLength(0);
  });
});

describe("PostgresModel relations", () => {
  interface RelUser {
    id: number;
    name: string;
  }
  interface RelPost {
    id: number;
    title: string;
    userId: number;
  }

  const relUserSchema: ModelSchema = {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    name: { type: DataTypes.STRING },
  };
  const relPostSchema: ModelSchema = {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    title: { type: DataTypes.STRING },
    userId: { type: DataTypes.INTEGER, references: { model: "users" } },
  };

  test("createTable emits a REFERENCES constraint for a references column", async () => {
    const pool = makePool();
    const model = new PostgresModel<RelPost>("posts", relPostSchema, pool);
    await model.init();
    const createTableSql = pool.query.mock.calls[0][0] as string;
    expect(createTableSql).toContain(
      '"userId" INTEGER REFERENCES "users" ("id")'
    );
  });

  test("createTable rejects unsafe references.model values", async () => {
    const pool = makePool();
    const badSchema: ModelSchema = {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        references: { model: "users; DROP TABLE users;--" },
      },
    };
    const model = new PostgresModel("posts", badSchema, pool);
    await expect(model.init()).rejects.toThrow(InvalidIdentifierError);
  });

  test("hasMany + include batches a single query per association and attaches results", async () => {
    const usersPool = makePool([
      { id: 1, name: "Ada" },
      { id: 2, name: "Bob" },
    ]);
    const users = new PostgresModel<RelUser>("users", relUserSchema, usersPool);

    const postsPool = makePool([
      { id: 10, title: "Post A", userId: 1 },
      { id: 11, title: "Post B", userId: 1 },
      { id: 12, title: "Post C", userId: 2 },
    ]);
    const posts = new PostgresModel<RelPost>("posts", relPostSchema, postsPool);

    users.hasMany(posts, { foreignKey: "userId", as: "posts" });

    const result = await users.findAll({}, { include: ["posts"] });

    expect(postsPool.query).toHaveBeenCalledTimes(1);
    expect((result[0] as unknown as { posts: unknown }).posts).toEqual([
      { id: 10, title: "Post A", userId: 1 },
      { id: 11, title: "Post B", userId: 1 },
    ]);
    expect((result[1] as unknown as { posts: unknown }).posts).toEqual([
      { id: 12, title: "Post C", userId: 2 },
    ]);
  });

  test("belongsTo + include attaches a single related record or null", async () => {
    const usersPool = makePool([{ id: 1, name: "Ada" }]);
    const users = new PostgresModel<RelUser>("users", relUserSchema, usersPool);

    const postsPool = makePool([
      { id: 10, title: "Post A", userId: 1 },
      { id: 11, title: "Orphan", userId: 99 },
    ]);
    const posts = new PostgresModel<RelPost>("posts", relPostSchema, postsPool);

    posts.belongsTo(users, { foreignKey: "userId", as: "author" });

    const result = await posts.findAll({}, { include: ["author"] });

    expect((result[0] as unknown as { author: unknown }).author).toEqual({
      id: 1,
      name: "Ada",
    });
    expect((result[1] as unknown as { author: unknown }).author).toBeNull();
  });

  test("findAll rejects an unregistered include name", async () => {
    const pool = makePool();
    const model = new PostgresModel<RelPost>("posts", relPostSchema, pool);
    await expect(model.findAll({}, { include: ["nope"] })).rejects.toThrow(
      ConfigurationError
    );
  });

  test("include is a no-op for an empty result set (no extra query issued)", async () => {
    const usersPool = makePool([]);
    const users = new PostgresModel<RelUser>("users", relUserSchema, usersPool);
    const postsPool = makePool([]);
    const posts = new PostgresModel<RelPost>("posts", relPostSchema, postsPool);
    users.hasMany(posts, { foreignKey: "userId", as: "posts" });

    await users.findAll({}, { include: ["posts"] });
    expect(postsPool.query).not.toHaveBeenCalled();
  });
});

describe("PostgresModel extended data types", () => {
  test("createTable emits the DDL for every new type, including length/precision/scale", async () => {
    const pool = makePool();
    const model = new PostgresModel(
      "widgets",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        bigCount: { type: DataTypes.BIGINT },
        precise: { type: DataTypes.DOUBLE },
        price: { type: DataTypes.DECIMAL, precision: 10, scale: 2 },
        rawDecimal: { type: DataTypes.DECIMAL },
        code: { type: DataTypes.STRING, length: 40 },
        externalId: { type: DataTypes.UUID },
        publishedOn: { type: DataTypes.DATEONLY },
        payload: { type: DataTypes.BINARY },
      },
      pool
    );
    await model.init();

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('"bigCount" BIGINT');
    expect(sql).toContain('"precise" DOUBLE PRECISION');
    expect(sql).toContain('"price" NUMERIC(10, 2)');
    expect(sql).toContain('"rawDecimal" NUMERIC');
    expect(sql).not.toContain('"rawDecimal" NUMERIC(');
    expect(sql).toContain('"code" VARCHAR(40)');
    expect(sql).toContain('"externalId" UUID');
    expect(sql).toContain('"publishedOn" DATE');
    expect(sql).toContain('"payload" BYTEA');
  });

  test("ENUM emits a TEXT column with a CHECK constraint, escaping single quotes", async () => {
    const pool = makePool();
    const model = new PostgresModel(
      "tickets",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        status: {
          type: DataTypes.ENUM,
          values: ["open", "closed", "won't fix"],
        },
      },
      pool
    );
    await model.init();

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain(
      `"status" TEXT CHECK ("status" IN ('open', 'closed', 'won''t fix'))`
    );
  });

  test("constructor throws ConfigurationError for a misconfigured schema", () => {
    const pool = makePool();
    expect(
      () =>
        new PostgresModel(
          "t",
          {
            id: { type: DataTypes.INTEGER, primaryKey: true },
            status: { type: DataTypes.ENUM },
          },
          pool
        )
    ).toThrow(ConfigurationError);
    expect(
      () =>
        new PostgresModel(
          "t",
          {
            id: { type: DataTypes.INTEGER, primaryKey: true },
            name: { type: DataTypes.STRING, values: ["a"] },
          },
          pool
        )
    ).toThrow(ConfigurationError);
    expect(
      () =>
        new PostgresModel(
          "t",
          {
            id: { type: DataTypes.INTEGER, primaryKey: true },
            name: { type: DataTypes.STRING, length: -1 },
          },
          pool
        )
    ).toThrow(ConfigurationError);
    expect(
      () =>
        new PostgresModel(
          "t",
          {
            id: { type: DataTypes.INTEGER, primaryKey: true },
            amount: { type: DataTypes.INTEGER, precision: 5 },
          },
          pool
        )
    ).toThrow(ConfigurationError);
  });

  test("create rejects a value outside the declared ENUM values", async () => {
    const pool = makePool();
    const model = new PostgresModel(
      "tickets",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        status: { type: DataTypes.ENUM, values: ["open", "closed"] },
      },
      pool
    );
    await expect(model.create({ status: "bogus" } as never)).rejects.toThrow(
      ValidationError
    );
  });

  test("update rejects a value outside the declared ENUM values", async () => {
    const pool = makePool([{ id: 1, status: "open" }]);
    const model = new PostgresModel(
      "tickets",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        status: { type: DataTypes.ENUM, values: ["open", "closed"] },
      },
      pool
    );
    await expect(model.update(1, { status: "bogus" } as never)).rejects.toThrow(
      ValidationError
    );
  });

  test("createMany rejects a row with an invalid ENUM value", async () => {
    const pool = makePool();
    const model = new PostgresModel(
      "tickets",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        status: { type: DataTypes.ENUM, values: ["open", "closed"] },
      },
      pool
    );
    await expect(
      model.createMany([{ status: "open" }, { status: "bogus" }] as never)
    ).rejects.toThrow(ValidationError);
  });

  test("a valid ENUM value passes through untouched", async () => {
    const pool = makePool([{ id: 1, status: "open" }]);
    const model = new PostgresModel(
      "tickets",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        status: { type: DataTypes.ENUM, values: ["open", "closed"] },
      },
      pool
    );
    await expect(model.create({ status: "open" } as never)).resolves.toEqual({
      id: 1,
      status: "open",
    });
  });
});
