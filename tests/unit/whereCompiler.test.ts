import { compileWhere } from "../../src/adapters/postgres/whereCompiler";
import { QueryError } from "../../src/errors";

const quote = (id: string) => `"${id}"`;

describe("compileWhere (PostgreSQL)", () => {
  test("empty where compiles to empty sql", () => {
    expect(compileWhere({}, quote)).toEqual({ sql: "", values: [] });
  });

  test("plain values compile to equality", () => {
    expect(compileWhere({ name: "Ada", age: 30 }, quote)).toEqual({
      sql: '"name" = $1 AND "age" = $2',
      values: ["Ada", 30],
    });
  });

  test("plain null compiles to IS NULL", () => {
    expect(compileWhere({ deletedAt: null }, quote)).toEqual({
      sql: '"deletedAt" IS NULL',
      values: [],
    });
  });

  test("comparison operators", () => {
    expect(compileWhere({ age: { $gte: 18, $lt: 65 } }, quote)).toEqual({
      sql: '"age" >= $1 AND "age" < $2',
      values: [18, 65],
    });
    expect(compileWhere({ age: { $eq: 21 } }, quote).sql).toBe('"age" = $1');
    expect(compileWhere({ age: { $ne: 21 } }, quote).sql).toBe('"age" <> $1');
    expect(compileWhere({ age: { $gt: 21 } }, quote).sql).toBe('"age" > $1');
    expect(compileWhere({ age: { $lte: 21 } }, quote).sql).toBe('"age" <= $1');
  });

  test("$eq/$ne with null map to IS NULL / IS NOT NULL", () => {
    expect(compileWhere({ a: { $eq: null } }, quote).sql).toBe('"a" IS NULL');
    expect(compileWhere({ a: { $ne: null } }, quote).sql).toBe(
      '"a" IS NOT NULL'
    );
  });

  test("$in compiles to ANY with an array parameter", () => {
    expect(compileWhere({ role: { $in: ["admin", "editor"] } }, quote)).toEqual(
      {
        sql: '"role" = ANY($1)',
        values: [["admin", "editor"]],
      }
    );
  });

  test("$nin compiles to <> ALL", () => {
    expect(compileWhere({ role: { $nin: ["bot"] } }, quote)).toEqual({
      sql: '"role" <> ALL($1)',
      values: [["bot"]],
    });
  });

  test("empty $in is always false; empty $nin always true", () => {
    expect(compileWhere({ role: { $in: [] } }, quote).sql).toBe("FALSE");
    expect(compileWhere({ role: { $nin: [] } }, quote).sql).toBe("TRUE");
  });

  test("$like and $null", () => {
    expect(compileWhere({ name: { $like: "A%" } }, quote)).toEqual({
      sql: '"name" LIKE $1',
      values: ["A%"],
    });
    expect(compileWhere({ email: { $null: true } }, quote).sql).toBe(
      '"email" IS NULL'
    );
    expect(compileWhere({ email: { $null: false } }, quote).sql).toBe(
      '"email" IS NOT NULL'
    );
  });

  test("$or joins parenthesized branches", () => {
    expect(
      compileWhere({ $or: [{ plan: "pro" }, { credits: { $gt: 0 } }] }, quote)
    ).toEqual({
      sql: '("plan" = $1 OR "credits" > $2)',
      values: ["pro", 0],
    });
  });

  test("multi-condition $or branches get their own parens", () => {
    const { sql } = compileWhere({ $or: [{ a: 1, b: 2 }, { c: 3 }] }, quote);
    expect(sql).toBe('(("a" = $1 AND "b" = $2) OR "c" = $3)');
  });

  test("$and combines with surrounding conditions", () => {
    const { sql, values } = compileWhere(
      { active: true, $and: [{ age: { $gte: 18 } }, { age: { $lt: 65 } }] },
      quote
    );
    expect(sql).toBe('"active" = $1 AND ("age" >= $2 AND "age" < $3)');
    expect(values).toEqual([true, 18, 65]);
  });

  test("startIndex offsets every placeholder", () => {
    expect(compileWhere({ name: "Ada" }, quote, 5)).toEqual({
      sql: '"name" = $5',
      values: ["Ada"],
    });
  });

  test("rejects unknown operators and mixed keys", () => {
    expect(() => compileWhere({ age: { $gte: 1, $bogus: 2 } }, quote)).toThrow(
      QueryError
    );
    expect(() => compileWhere({ age: { $gte: 1, plain: 2 } }, quote)).toThrow(
      QueryError
    );
  });

  test("rejects malformed operand types", () => {
    expect(() => compileWhere({ a: { $in: "not-array" } }, quote)).toThrow(
      QueryError
    );
    expect(() => compileWhere({ a: { $like: 42 } }, quote)).toThrow(QueryError);
    expect(() => compileWhere({ a: { $null: "yes" } }, quote)).toThrow(
      QueryError
    );
  });

  test("Date values are passed as parameters, not treated as operator objects", () => {
    const date = new Date("2026-01-01");
    expect(compileWhere({ createdAt: date }, quote)).toEqual({
      sql: '"createdAt" = $1',
      values: [date],
    });
  });
});
