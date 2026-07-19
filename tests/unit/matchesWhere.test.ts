import { matchesWhere } from "../../src/realtime/matchesWhere";
import { QueryError } from "../../src/errors";

describe("matchesWhere", () => {
  test("plain values mean equality", () => {
    expect(matchesWhere({ status: "urgent" }, { status: "urgent" })).toBe(true);
    expect(matchesWhere({ status: "normal" }, { status: "urgent" })).toBe(
      false
    );
  });

  test("an empty where matches everything", () => {
    expect(matchesWhere({ anything: 1 }, {})).toBe(true);
  });

  test("multiple fields are ANDed together", () => {
    const data = { status: "urgent", assignee: "ada" };
    expect(matchesWhere(data, { status: "urgent", assignee: "ada" })).toBe(
      true
    );
    expect(matchesWhere(data, { status: "urgent", assignee: "bob" })).toBe(
      false
    );
  });

  test("comparison operators", () => {
    expect(matchesWhere({ age: 20 }, { age: { $gt: 18 } })).toBe(true);
    expect(matchesWhere({ age: 18 }, { age: { $gt: 18 } })).toBe(false);
    expect(matchesWhere({ age: 18 }, { age: { $gte: 18 } })).toBe(true);
    expect(matchesWhere({ age: 17 }, { age: { $lt: 18 } })).toBe(true);
    expect(matchesWhere({ age: 18 }, { age: { $lte: 18 } })).toBe(true);
    expect(matchesWhere({ age: 20 }, { age: { $ne: 18 } })).toBe(true);
  });

  test("$gt/$lt work on Dates", () => {
    const cutoff = new Date("2026-01-01");
    expect(
      matchesWhere(
        { createdAt: new Date("2026-06-01") },
        { createdAt: { $gt: cutoff } }
      )
    ).toBe(true);
    expect(
      matchesWhere(
        { createdAt: new Date("2025-01-01") },
        { createdAt: { $gt: cutoff } }
      )
    ).toBe(false);
  });

  test("$in / $nin", () => {
    expect(
      matchesWhere({ role: "admin" }, { role: { $in: ["admin", "editor"] } })
    ).toBe(true);
    expect(
      matchesWhere({ role: "viewer" }, { role: { $in: ["admin", "editor"] } })
    ).toBe(false);
    expect(
      matchesWhere({ role: "viewer" }, { role: { $nin: ["admin", "editor"] } })
    ).toBe(true);
  });

  test("$like translates SQL wildcards", () => {
    expect(
      matchesWhere({ name: "Ada Lovelace" }, { name: { $like: "Ada%" } })
    ).toBe(true);
    expect(matchesWhere({ name: "Bob" }, { name: { $like: "Ada%" } })).toBe(
      false
    );
  });

  test("$null", () => {
    expect(
      matchesWhere({ deletedAt: null }, { deletedAt: { $null: true } })
    ).toBe(true);
    expect(
      matchesWhere({ deletedAt: undefined }, { deletedAt: { $null: true } })
    ).toBe(true);
    expect(
      matchesWhere({ deletedAt: new Date() }, { deletedAt: { $null: true } })
    ).toBe(false);
    expect(
      matchesWhere({ deletedAt: new Date() }, { deletedAt: { $null: false } })
    ).toBe(true);
  });

  test("$or combinator", () => {
    const where = { $or: [{ status: "urgent" }, { priority: { $gte: 8 } }] };
    expect(matchesWhere({ status: "urgent", priority: 1 }, where)).toBe(true);
    expect(matchesWhere({ status: "normal", priority: 9 }, where)).toBe(true);
    expect(matchesWhere({ status: "normal", priority: 1 }, where)).toBe(false);
  });

  test("$and combinator", () => {
    const where = { $and: [{ status: "urgent" }, { priority: { $gte: 8 } }] };
    expect(matchesWhere({ status: "urgent", priority: 9 }, where)).toBe(true);
    expect(matchesWhere({ status: "urgent", priority: 1 }, where)).toBe(false);
  });

  test("throws QueryError for unknown operators (typo protection)", () => {
    expect(() =>
      matchesWhere({ age: 18 }, { age: { $bogus: 1 } as never })
    ).toThrow(QueryError);
  });
});
