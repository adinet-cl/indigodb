import { DataTypes, POSTGRES_TYPE_MAP } from "../../src/dataTypes";

describe("DataTypes", () => {
  test("exposes all documented types", () => {
    expect(Object.keys(DataTypes).sort()).toEqual(
      ["BOOLEAN", "DATE", "FLOAT", "INTEGER", "JSON", "STRING", "TEXT"].sort()
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
});
