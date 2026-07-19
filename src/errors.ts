export class IndigoDBError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends IndigoDBError {}

export class ConnectionError extends IndigoDBError {}

export class UnsupportedTypeError extends IndigoDBError {
  constructor(type: string) {
    super(`Unsupported data type: "${type}"`);
  }
}

export class InvalidIdentifierError extends IndigoDBError {
  constructor(identifier: string) {
    super(
      `Invalid identifier: "${identifier}". Identifiers must start with a letter or underscore, ` +
        `contain only letters, digits and underscores, and be at most 63 characters long.`
    );
  }
}

export class UnknownColumnError extends IndigoDBError {
  constructor(column: string, model: string) {
    super(`Unknown column "${column}" for model "${model}"`);
  }
}

export class QueryError extends IndigoDBError {}
