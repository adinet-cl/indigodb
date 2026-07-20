import { DataTypes, POSTGRES_TYPE_MAP } from "../../src/dataTypes";

describe("DataTypes", () => {
  test("exposes all documented types", () => {
    expect(Object.keys(DataTypes).sort()).toEqual(
      [
        "INTEGER",
        "BIGINT",
        "FLOAT",
        "DOUBLE",
        "DECIMAL",
        "STRING",
        "TEXT",
        "BOOLEAN",
        "DATE",
        "DATEONLY",
        "UUID",
        "ENUM",
        "BINARY",
        "JSON",
      ].sort()
    );
  });

  test("every type has a PostgreSQL mapping", () => {
    for (const type of Object.values(DataTypes)) {
      expect(POSTGRES_TYPE_MAP[type]).toBeDefined();
    }
  });

  test("JSON maps to JSONB", () => {
    expect(POSTGRES_TYPE_MAP.JSON).toBe("JSONB");
  });

  test("base mappings for the new types (parameterized ones are resolved at table-creation time)", () => {
    expect(POSTGRES_TYPE_MAP.BIGINT).toBe("BIGINT");
    expect(POSTGRES_TYPE_MAP.DOUBLE).toBe("DOUBLE PRECISION");
    expect(POSTGRES_TYPE_MAP.DECIMAL).toBe("NUMERIC");
    expect(POSTGRES_TYPE_MAP.UUID).toBe("UUID");
    expect(POSTGRES_TYPE_MAP.ENUM).toBe("TEXT");
    expect(POSTGRES_TYPE_MAP.DATEONLY).toBe("DATE");
    expect(POSTGRES_TYPE_MAP.BINARY).toBe("BYTEA");
  });
});
