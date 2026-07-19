import { QueryError } from "../errors";

/**
 * Mongo-style filter operators, supported by both backends. On PostgreSQL
 * they are compiled to parameterized SQL; on MongoDB they map (almost)
 * directly to native query operators.
 */
export interface FieldOperators {
  $eq?: unknown;
  $ne?: unknown;
  $gt?: unknown;
  $gte?: unknown;
  $lt?: unknown;
  $lte?: unknown;
  $in?: unknown[];
  $nin?: unknown[];
  /** SQL LIKE pattern (`%` and `_` wildcards); translated to a regex on MongoDB. */
  $like?: string;
  /** `true` → IS NULL / equals null; `false` → IS NOT NULL / not null. */
  $null?: boolean;
}

export const OPERATOR_KEYS = new Set<string>([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$like",
  "$null",
]);

/**
 * A filter tree: plain values mean equality (v2.0-compatible), objects of
 * `$operators` refine a field, and `$or`/`$and` combine sub-filters.
 */
export type Where<T> = {
  [K in keyof T]?: T[K] | FieldOperators;
} & {
  $or?: Where<T>[];
  $and?: Where<T>[];
};

export type OrderDirection = "asc" | "desc";

export interface QueryOptions<T> {
  orderBy?: Partial<Record<Extract<keyof T, string>, OrderDirection>>;
  limit?: number;
  offset?: number;
  select?: Extract<keyof T, string>[];
  /** Association names (registered via `hasMany`/`belongsTo`) to eager-load. */
  include?: string[];
}

/**
 * True when `value` is an operator object like `{ $gte: 18 }`. Mixing
 * operator and non-operator keys, or using an unknown `$op`, is an error —
 * this catches typos like `{ $gte: 18, $limit: 5 }` instead of silently
 * treating them as equality.
 */
export function isOperatorObject(value: unknown): value is FieldOperators {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  const operatorKeys = keys.filter((key) => key.startsWith("$"));
  if (operatorKeys.length === 0) return false;
  if (operatorKeys.length !== keys.length) {
    throw new QueryError(
      `Cannot mix operator and plain keys in a field filter: {${keys.join(", ")}}`
    );
  }
  for (const key of operatorKeys) {
    if (!OPERATOR_KEYS.has(key)) {
      throw new QueryError(`Unknown filter operator "${key}"`);
    }
  }
  return true;
}

/**
 * Walks a Where tree invoking `onField` for every referenced column name,
 * validating the `$or`/`$and` structure along the way. Backends use this to
 * reject unknown columns before compiling.
 */
export function walkWhere(
  where: Record<string, unknown>,
  onField: (field: string) => void
): void {
  for (const [key, value] of Object.entries(where)) {
    if (key === "$or" || key === "$and") {
      if (!Array.isArray(value) || value.length === 0) {
        throw new QueryError(`"${key}" expects a non-empty array of filters`);
      }
      for (const branch of value) {
        if (branch === null || typeof branch !== "object") {
          throw new QueryError(`"${key}" branches must be filter objects`);
        }
        walkWhere(branch as Record<string, unknown>, onField);
      }
    } else if (key.startsWith("$")) {
      throw new QueryError(`Unknown filter combinator "${key}"`);
    } else {
      // Validates operator-object shape (throws on typos) as a side effect.
      isOperatorObject(value);
      onField(key);
    }
  }
}

/** Validates limit/offset values before they reach a query. */
export function assertNonNegativeInteger(
  value: number,
  label: string
): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new QueryError(`"${label}" must be a non-negative integer`);
  }
  return value;
}
