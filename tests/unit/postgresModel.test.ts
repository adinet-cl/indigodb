import { PostgresModel } from "../../src/adapters/postgres/postgresModel";
import { DataTypes } from "../../src/dataTypes";
import {
  ConfigurationError,
  InvalidIdentifierError,
  QueryError,
  UnknownColumnError,
  UnsupportedTypeError,
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
        new PostgresModel("users", { name: { type: DataTypes.STRING } }, makePool())
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

    const result = await model.create({ name: "Ada", email: "ada@example.com" });

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
    await expect(
      model.findAll({ "1=1; --": "x" } as never)
    ).rejects.toThrow(UnknownColumnError);
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
    await expect(
      model.findAll({ "evil; --": 1 } as never)
    ).rejects.toThrow(UnknownColumnError);
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

    const emptyModel = new PostgresModel<User>("users", userSchema, makePool([]));
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
    const pool = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 3 }) };
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
    const pool = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 9 }) };
    const model = new PostgresModel<User>("users", userSchema, pool);

    const removed = await model.deleteMany({});

    expect(pool.query).toHaveBeenCalledWith('DELETE FROM "users"', []);
    expect(removed).toBe(9);
  });

  test("limit/offset must be non-negative integers", async () => {
    const model = new PostgresModel<User>("users", userSchema, makePool());
    await expect(model.findAll({}, { limit: -1 })).rejects.toThrow(QueryError);
    await expect(model.findAll({}, { offset: 1.5 })).rejects.toThrow(QueryError);
  });
});
