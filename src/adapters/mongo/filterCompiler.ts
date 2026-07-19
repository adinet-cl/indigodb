import { QueryError } from "../../errors";
import { FieldOperators, isOperatorObject } from "../../query/where";

/**
 * Translates a SQL LIKE pattern (`%`, `_` wildcards) into an anchored,
 * escaped RegExp so metacharacters in the pattern cannot inject regex.
 */
export function likeToRegex(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "%") source += ".*";
    else if (char === "_") source += ".";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * Compiles a Where tree into a native MongoDB filter. Column names must be
 * validated against the model schema BEFORE calling this. `coerceValue`
 * applies schema-based coercion (and ObjectId conversion for the primary key).
 */
export function compileFilter(
  where: Record<string, unknown>,
  coerceValue: (field: string, value: unknown) => unknown
): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(where)) {
    if (key === "$or" || key === "$and") {
      filter[key] = (value as Record<string, unknown>[]).map((branch) =>
        compileFilter(branch, coerceValue)
      );
    } else if (isOperatorObject(value)) {
      filter[key] = compileOperators(key, value, coerceValue);
    } else {
      filter[key] = coerceValue(key, value);
    }
  }

  return filter;
}

function compileOperators(
  field: string,
  operators: FieldOperators,
  coerceValue: (field: string, value: unknown) => unknown
): Record<string, unknown> {
  const compiled: Record<string, unknown> = {};

  for (const [op, operand] of Object.entries(operators)) {
    switch (op) {
      case "$eq":
      case "$ne":
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte":
        compiled[op] = coerceValue(field, operand);
        break;
      case "$in":
      case "$nin":
        if (!Array.isArray(operand)) {
          throw new QueryError(`"${op}" expects an array`);
        }
        compiled[op] = operand.map((item) => coerceValue(field, item));
        break;
      case "$like":
        if (typeof operand !== "string") {
          throw new QueryError('"$like" expects a string pattern');
        }
        compiled.$regex = likeToRegex(operand);
        break;
      case "$null":
        if (typeof operand !== "boolean") {
          throw new QueryError('"$null" expects a boolean');
        }
        if (operand) compiled.$eq = null;
        else compiled.$ne = null;
        break;
      default:
        throw new QueryError(`Unknown filter operator "${op}"`);
    }
  }

  return compiled;
}
