import { QueryError } from "../../errors";
import { FieldOperators, isOperatorObject } from "../../query/where";

export interface CompiledWhere {
  /** WHERE-clause body (no `WHERE` keyword); empty string when no filters. */
  sql: string;
  values: unknown[];
}

/**
 * Compiles a Where tree into a parameterized SQL condition. Column names must
 * be validated against the model schema BEFORE calling this (the compiler
 * quotes them but does not know the schema).
 */
export function compileWhere(
  where: Record<string, unknown>,
  quote: (identifier: string) => string,
  startIndex = 1
): CompiledWhere {
  const values: unknown[] = [];

  const placeholder = (value: unknown): string => {
    values.push(value);
    return `$${startIndex + values.length - 1}`;
  };

  const compileGroup = (group: Record<string, unknown>): string[] => {
    const conditions: string[] = [];
    for (const [key, value] of Object.entries(group)) {
      if (key === "$or" || key === "$and") {
        const joiner = key === "$or" ? " OR " : " AND ";
        const branches = (value as Record<string, unknown>[]).map((branch) => {
          const parts = compileGroup(branch);
          return parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`;
        });
        conditions.push(
          branches.length === 1 ? branches[0]! : `(${branches.join(joiner)})`
        );
      } else {
        conditions.push(...compileField(key, value));
      }
    }
    return conditions;
  };

  const compileField = (field: string, value: unknown): string[] => {
    const column = quote(field);
    if (isOperatorObject(value)) {
      return Object.entries(value as FieldOperators).map(([op, operand]) =>
        compileOperator(column, op, operand)
      );
    }
    if (value === null) return [`${column} IS NULL`];
    return [`${column} = ${placeholder(value)}`];
  };

  const compileOperator = (
    column: string,
    op: string,
    operand: unknown
  ): string => {
    switch (op) {
      case "$eq":
        return operand === null
          ? `${column} IS NULL`
          : `${column} = ${placeholder(operand)}`;
      case "$ne":
        return operand === null
          ? `${column} IS NOT NULL`
          : `${column} <> ${placeholder(operand)}`;
      case "$gt":
        return `${column} > ${placeholder(operand)}`;
      case "$gte":
        return `${column} >= ${placeholder(operand)}`;
      case "$lt":
        return `${column} < ${placeholder(operand)}`;
      case "$lte":
        return `${column} <= ${placeholder(operand)}`;
      case "$in": {
        const list = expectArray(op, operand);
        return list.length === 0
          ? "FALSE"
          : `${column} = ANY(${placeholder(list)})`;
      }
      case "$nin": {
        const list = expectArray(op, operand);
        return list.length === 0
          ? "TRUE"
          : `${column} <> ALL(${placeholder(list)})`;
      }
      case "$like":
        if (typeof operand !== "string") {
          throw new QueryError('"$like" expects a string pattern');
        }
        return `${column} LIKE ${placeholder(operand)}`;
      case "$null":
        if (typeof operand !== "boolean") {
          throw new QueryError('"$null" expects a boolean');
        }
        return operand ? `${column} IS NULL` : `${column} IS NOT NULL`;
      default:
        // isOperatorObject already rejects unknown operators; defensive only.
        throw new QueryError(`Unknown filter operator "${op}"`);
    }
  };

  const conditions = compileGroup(where);
  return { sql: conditions.join(" AND "), values };
}

function expectArray(op: string, operand: unknown): unknown[] {
  if (!Array.isArray(operand)) {
    throw new QueryError(`"${op}" expects an array`);
  }
  return operand;
}
