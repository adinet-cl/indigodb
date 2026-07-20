import {
  ChangeStream,
  ChangeStreamDocument,
  Collection,
  Db,
  Document,
  MongoClient,
  MongoClientOptions,
} from "mongodb";
import { DatabaseAdapter, TransactionContext } from "../adapter";
import { BaseModel } from "../../models/baseModel";
import { MongoModel } from "./mongoModel";
import {
  ChangeEvent,
  ModelOptions,
  ModelSchema,
  MongoConfig,
} from "../../types";
import { ConfigurationError, ConnectionError, QueryError } from "../../errors";
import { Logger, noopLogger } from "../../logger";

/**
 * MongoDB backend: change streams (which require a replica set) feed the
 * real-time change events. All streams are tracked so disconnect() can close
 * them cleanly.
 */
const STREAM_RETRY_DELAY_MS = 5000;

export class MongoAdapter extends DatabaseAdapter {
  private client?: MongoClient;
  private db?: Db;
  private closing = false;
  private readonly changeStreams: ChangeStream[] = [];
  private readonly models = new Map<string, MongoModel<unknown>>();

  constructor(
    private readonly config: MongoConfig,
    private readonly logger: Logger = noopLogger
  ) {
    super();
    if (!config.connectionString) {
      throw new ConfigurationError(
        "MongoDB configuration requires a connectionString"
      );
    }
  }

  public async connect(): Promise<void> {
    this.closing = false;
    this.client = new MongoClient(
      this.config.connectionString,
      this.config.options as MongoClientOptions | undefined
    );
    await this.client.connect();
    this.db = this.client.db(this.config.database);
    this.logger.debug("Connected to MongoDB");
  }

  public async defineModel<T>(
    name: string,
    schema: ModelSchema,
    options?: ModelOptions
  ): Promise<MongoModel<T>> {
    if (!this.db) {
      throw new ConnectionError("MongoAdapter is not connected");
    }
    // Redefining a model reuses the existing handle so we never open a second
    // change stream on the same collection (which would double-broadcast).
    const collection = this.db.collection(name);
    const model = new MongoModel<T>(name, schema, collection, options);
    const existing = this.models.get(model.name);
    if (existing) {
      if (JSON.stringify(existing.schema) !== JSON.stringify(schema)) {
        this.logger.warn(
          `Model "${model.name}" is already defined; ignoring the new schema ` +
            `(first definition wins). Call close() and reconnect to redefine it.`
        );
      }
      return existing as MongoModel<T>;
    }
    await model.init();
    this.models.set(model.name, model as MongoModel<unknown>);
    this.trackRedaction(model as unknown as BaseModel<unknown>);
    if (model.broadcastEnabled) {
      this.watchCollection(model.name, collection);
    }
    return model;
  }

  private watchCollection(
    modelName: string,
    collection: Collection<Document>,
    resumeToken?: unknown
  ): void {
    const stream = collection.watch([], {
      fullDocument: "updateLookup",
      ...(resumeToken ? { resumeAfter: resumeToken } : {}),
    });
    this.changeStreams.push(stream);

    // Track the latest resume token so an interrupted stream can pick up
    // where it left off instead of silently missing events.
    let lastToken: unknown = resumeToken;

    stream.on("change", (change: ChangeStreamDocument<Document>) => {
      lastToken = change._id;
      const event = this.toChangeEvent(modelName, change);
      if (event) this.emitChange(event);
    });

    stream.on("error", (err) => {
      this.logger.error(
        `Change stream error for collection "${modelName}"; scheduling restart`,
        err
      );
      const index = this.changeStreams.indexOf(stream);
      if (index !== -1) this.changeStreams.splice(index, 1);
      void stream.close().catch(() => undefined);
      // If this stream was a resume attempt that failed before delivering a
      // single change, the token is likely no longer in the oplog — restart
      // fresh and warn that events may have been missed. Otherwise resume
      // from the newest token we saw.
      const tokenIsStale =
        resumeToken !== undefined && lastToken === resumeToken;
      if (tokenIsStale) {
        this.logger.warn(
          `Resume token for "${modelName}" appears invalid; restarting the ` +
            `change stream from now — events may have been missed.`
        );
      }
      this.scheduleWatchRestart(
        modelName,
        collection,
        tokenIsStale ? undefined : lastToken
      );
    });
  }

  private scheduleWatchRestart(
    modelName: string,
    collection: Collection<Document>,
    resumeToken?: unknown
  ): void {
    if (this.closing) return;
    const timer = setTimeout(() => {
      if (this.closing) return;
      try {
        this.watchCollection(modelName, collection, resumeToken);
      } catch (err) {
        this.logger.error(
          `Failed to restart change stream for "${modelName}"`,
          err
        );
        this.scheduleWatchRestart(modelName, collection, resumeToken);
      }
    }, STREAM_RETRY_DELAY_MS);
    timer.unref();
  }

  private toChangeEvent(
    modelName: string,
    change: ChangeStreamDocument<Document>
  ): ChangeEvent | null {
    switch (change.operationType) {
      case "insert":
        return {
          model: modelName,
          operation: "INSERT",
          data: change.fullDocument,
        };
      case "update":
      case "replace":
        if (!change.fullDocument) {
          this.logger.warn(
            `fullDocument unavailable for ${change.operationType} on "${modelName}"`
          );
          return null;
        }
        return {
          model: modelName,
          operation: "UPDATE",
          data: change.fullDocument,
        };
      case "delete":
        return {
          model: modelName,
          operation: "DELETE",
          data: { _id: change.documentKey._id },
        };
      default:
        return null;
    }
  }

  public async transaction<R>(
    fn: (tx: TransactionContext) => Promise<R>
  ): Promise<R> {
    if (!this.client) {
      throw new ConnectionError("MongoAdapter is not connected");
    }
    const session = this.client.startSession();
    try {
      let result: R | undefined;
      // withTransaction retries the callback on transient transaction errors,
      // so `fn` must be safe to run more than once — it only reads model
      // handles and performs the caller's operations, no local side effects.
      await session.withTransaction(async () => {
        const ctx: TransactionContext = {
          getModel: <T>(model: BaseModel<T>): BaseModel<T> => {
            if (!(model instanceof MongoModel)) {
              throw new ConfigurationError(
                "transaction.getModel() was passed a model from a different adapter"
              );
            }
            return model.withSession(session) as unknown as BaseModel<T>;
          },
        };
        result = await fn(ctx);
      });
      return result as R;
    } finally {
      await session.endSession();
    }
  }

  public async raw(query: unknown, _params?: unknown[]): Promise<unknown> {
    if (!this.db) {
      throw new ConnectionError("MongoAdapter is not connected");
    }
    if (query === null || typeof query !== "object" || Array.isArray(query)) {
      throw new QueryError("MongoDB raw() expects a command document");
    }
    return this.db.command(query as Document);
  }

  public async disconnect(): Promise<void> {
    this.closing = true;
    await Promise.all(
      this.changeStreams.map((stream) =>
        stream.close().catch((err) => {
          this.logger.warn("Error closing change stream", err);
        })
      )
    );
    this.changeStreams.length = 0;
    this.models.clear();
    if (this.client) {
      await this.client.close();
      this.client = undefined;
      this.db = undefined;
    }
  }
}
