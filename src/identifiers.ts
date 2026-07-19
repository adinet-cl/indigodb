import { InvalidIdentifierError } from "./errors";

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// PostgreSQL truncates identifiers longer than 63 bytes; reject them up front.
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Validates a table/collection or column name before it is interpolated into
 * SQL text, guarding against SQL injection through identifiers.
 */
export function assertValidIdentifier(identifier: string): string {
  if (
    identifier.length === 0 ||
    identifier.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(identifier)
  ) {
    throw new InvalidIdentifierError(identifier);
  }
  return identifier;
}
