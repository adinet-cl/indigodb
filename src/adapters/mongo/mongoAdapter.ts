import {
  ChangeStream,
  ChangeStreamDocument,
  Collection,
  Db,
  Document,
  MongoClient,
} from "mongodb";
import { DatabaseAdapter } from "../adapter";
import { MongoModel } from "./mongoModel";
import { ChangeEvent, ModelSchema, MongoConfig } from "../../types";
import { ConfigurationError, ConnectionError } from "../../errors";
import { Logger, noopLogger } from "../../logger";

/**
 * MongoDB backend: change streams (which require a replica set) feed the
 * real-time change events. All streams are tracked so disconnect() can close
 * them cleanly.
 */
export class MongoAdapter extends DatabaseAdapter {
  private client?: MongoClient;
  private db?: Db;
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
    this.client = new MongoClient(this.config.connectionString);
    await this.client.connect();
    this.db = this.client.db(this.config.database);
    this.logger.debug("Connected to MongoDB");
  }

  public async defineModel<T>(
    name: string,
    schema: ModelSchema
  ): Promise<MongoModel<T>> {
    if (!this.db) {
      throw new ConnectionError("MongoAdapter is not connected");
    }
    // Redefining a model reuses the existing handle so we never open a second
    // change stream on the same collection (which would double-broadcast).
    const collection = this.db.collection(name);
    const model = new MongoModel<T>(name, schema, collection);
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
    this.models.set(model.name, model as MongoModel<unknown>);
    this.watchCollection(model.name, collection);
    return model;
  }

  private watchCollection(
    modelName: string,
    collection: Collection<Document>
  ): void {
    const stream = collection.watch([], { fullDocument: "updateLookup" });
    this.changeStreams.push(stream);

    stream.on("change", (change: ChangeStreamDocument<Document>) => {
      const event = this.toChangeEvent(modelName, change);
      if (event) this.emitChange(event);
    });

    stream.on("error", (err) => {
      this.logger.error(
        `Change stream error for collection "${modelName}"`,
        err
      );
    });
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

  public async disconnect(): Promise<void> {
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
