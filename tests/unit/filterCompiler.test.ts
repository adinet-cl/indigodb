import {
  compileFilter,
  likeToRegex,
} from "../../src/adapters/mongo/filterCompiler";
import { QueryError } from "../../src/errors";

const identity = (_field: string, value: unknown) => value;

describe("likeToRegex", () => {
  test("translates % and _ wildcards", () => {
    expect(likeToRegex("A%").test("Ada")).toBe(true);
    expect(likeToRegex("A%").test("Bob")).toBe(false);
    expect(likeToRegex("_da").test("Ada")).toBe(true);
    expect(likeToRegex("_da").test("Amanda")).toBe(false);
  });

  test("escapes regex metacharacters in the pattern", () => {
    expect(likeToRegex("a.b%").test("a.bc")).toBe(true);
    expect(likeToRegex("a.b%").test("aXbc")).toBe(false);
    expect(likeToRegex("(x)+?%").test("(x)+?!")).toBe(true);
  });

  test("is fully anchored", () => {
    expect(likeToRegex("da").test("Ada")).toBe(false);
  });
});

describe("compileFilter (MongoDB)", () => {
  test("plain values pass through coercion as equality", () => {
    const coerce = jest.fn((field: string, value: unknown) =>
      field === "age" ? Number(value) : value
    );
    expect(compileFilter({ name: "Ada", age: "30" }, coerce)).toEqual({
      name: "Ada",
      age: 30,
    });
  });

  test("comparison operators map natively with coercion", () => {
    const coerce = (_f: string, v: unknown) => Number(v);
    expect(compileFilter({ age: { $gte: "18", $lt: "65" } }, coerce)).toEqual({
      age: { $gte: 18, $lt: 65 },
    });
  });

  test("$in/$nin coerce element-wise", () => {
    const coerce = (_f: string, v: unknown) => Number(v);
    expect(compileFilter({ n: { $in: ["1", "2"] } }, coerce)).toEqual({
      n: { $in: [1, 2] },
    });
  });

  test("$like becomes an anchored $regex", () => {
    const filter = compileFilter({ name: { $like: "A%" } }, identity) as {
      name: { $regex: RegExp };
    };
    expect(filter.name.$regex).toBeInstanceOf(RegExp);
    expect(filter.name.$regex.test("Ada")).toBe(true);
    expect(filter.name.$regex.test("Bob")).toBe(false);
  });

  test("$null maps to null equality", () => {
    expect(compileFilter({ a: { $null: true } }, identity)).toEqual({
      a: { $eq: null },
    });
    expect(compileFilter({ a: { $null: false } }, identity)).toEqual({
      a: { $ne: null },
    });
  });

  test("$or/$and recurse", () => {
    expect(
      compileFilter(
        { $or: [{ plan: "pro" }, { credits: { $gt: 0 } }] },
        identity
      )
    ).toEqual({ $or: [{ plan: "pro" }, { credits: { $gt: 0 } }] });
  });

  test("rejects unknown operators and malformed operands", () => {
    expect(() => compileFilter({ a: { $bogus: 1 } }, identity)).toThrow(
      QueryError
    );
    expect(() => compileFilter({ a: { $in: "x" } }, identity)).toThrow(
      QueryError
    );
    expect(() => compileFilter({ a: { $like: 9 } }, identity)).toThrow(
      QueryError
    );
  });
});
