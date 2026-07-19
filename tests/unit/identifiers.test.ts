import { assertValidIdentifier } from "../../src/identifiers";
import { InvalidIdentifierError } from "../../src/errors";

describe("assertValidIdentifier", () => {
  test("accepts valid identifiers", () => {
    expect(assertValidIdentifier("users")).toBe("users");
    expect(assertValidIdentifier("_private")).toBe("_private");
    expect(assertValidIdentifier("Table_2")).toBe("Table_2");
  });

  test("rejects SQL injection attempts", () => {
    expect(() => assertValidIdentifier("users; DROP TABLE users;--")).toThrow(
      InvalidIdentifierError
    );
    expect(() => assertValidIdentifier('users"')).toThrow(
      InvalidIdentifierError
    );
    expect(() => assertValidIdentifier("users where 1=1")).toThrow(
      InvalidIdentifierError
    );
  });

  test("rejects identifiers starting with a digit", () => {
    expect(() => assertValidIdentifier("1users")).toThrow(
      InvalidIdentifierError
    );
  });

  test("rejects empty and overlong identifiers", () => {
    expect(() => assertValidIdentifier("")).toThrow(InvalidIdentifierError);
    expect(() => assertValidIdentifier("a".repeat(64))).toThrow(
      InvalidIdentifierError
    );
    expect(assertValidIdentifier("a".repeat(63))).toBe("a".repeat(63));
  });
});
