import { FieldOperators, isOperatorObject, Where } from "../query/where";
import { likeToRegex } from "../adapters/mongo/filterCompiler";

/**
 * Interprets a Where tree directly against an in-memory object — used to
 * decide whether a ChangeEvent matches a client's real-time subscription
 * filter. Unlike the Postgres/Mongo compilers, this never touches a
 * database: it's a plain JS evaluator over the change payload.
 */
export function matchesWhere(
  data: Record<string, unknown>,
  where: Record<string, unknown> = {}
): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "$or") {
      return (condition as Where<unknown>[]).some((branch) =>
        matchesWhere(data, branch as Record<string, unknown>)
      );
    }
    if (key === "$and") {
      return (condition as Where<unknown>[]).every((branch) =>
        matchesWhere(data, branch as Record<string, unknown>)
      );
    }
    const value = data[key];
    return isOperatorObject(condition)
      ? matchesOperators(value, condition)
      : value === condition;
  });
}

function matchesOperators(value: unknown, ops: FieldOperators): boolean {
  if (ops.$eq !== undefined && value !== ops.$eq) return false;
  if (ops.$ne !== undefined && value === ops.$ne) return false;
  if (ops.$gt !== undefined && !isAfter(value, ops.$gt)) return false;
  if (ops.$gte !== undefined && !isAfterOrEqual(value, ops.$gte)) return false;
  if (ops.$lt !== undefined && !isAfter(ops.$lt, value)) return false;
  if (ops.$lte !== undefined && !isAfterOrEqual(ops.$lte, value)) return false;
  if (ops.$in !== undefined && !ops.$in.includes(value)) return false;
  if (ops.$nin !== undefined && ops.$nin.includes(value)) return false;
  if (
    ops.$like !== undefined &&
    !likeToRegex(ops.$like).test(String(value ?? ""))
  ) {
    return false;
  }
  if (ops.$null !== undefined) {
    const isNull = value === null || value === undefined;
    if (isNull !== ops.$null) return false;
  }
  return true;
}

/** Comparable-safe `a > b` for numbers, strings and Dates. */
function isAfter(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as never).getTime() > new Date(b as never).getTime();
  }
  return (a as never) > (b as never);
}

function isAfterOrEqual(a: unknown, b: unknown): boolean {
  return a === b || isAfter(a, b);
}
