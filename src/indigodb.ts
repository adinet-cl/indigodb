import { EventEmitter } from "node:events";
import { ChangeEvent, Config, DatabaseConfig, ModelSchema } from "./types";
import { DatabaseAdapter } from "./adapters/adapter";
import { PostgresAdapter } from "./adapters/postgres/postgresAdapter";
import { MongoAdapter } from "./adapters/mongo/mongoAdapter";
import { RealtimeGateway } from "./realtime/gateway";
import { WebSocketGateway } from "./realtime/websocketGateway";
import { BaseModel } from "./models/baseModel";
import { ConfigurationError, ConnectionError } from "./errors";
import { Logger, noopLogger } from "./logger";

const DEFAULT_WEBSOCKET_PORT = 8080;

function createAdapter(config: DatabaseConfig, logger: Logger): DatabaseAdapter {
  switch (config.type) {
    case "postgresql":
      return new PostgresAdapter(config, logger);
    case "mongodb":
      return new MongoAdapter(config, logger);
    default:
      throw new ConfigurationError(
        `Unsupported database type: "${(config as { type: string }).type}"`
      );
  }
}

/**
 * Facade that composes a DatabaseAdapter (Postgres or Mongo) with an optional
 * RealtimeGateway. Change events flow: adapter → this.emit("change") →
 * gateway.broadcast, so consumers can subscribe in-process or over WebSocket.
 */
export class IndigoDB extends EventEmitter {
  private readonly adapter: DatabaseAdapter;
  private readonly gateway?: RealtimeGateway;
  private readonly logger: Logger;
  private connected = false;

  constructor(config: Config) {
    super();
    if (!config?.database) {
      throw new ConfigurationError("Config must include a database section");
    }
    this.logger = config.logger ?? noopLogger;
    this.adapter = createAdapter(config.database, this.logger);

    if (config.realtime?.enabled) {
      this.gateway = new WebSocketGateway(
        config.realtime.port ?? DEFAULT_WEBSOCKET_PORT,
        this.logger
      );
    }

    this.adapter.on("change", (event: ChangeEvent) => {
      this.emit("change", event);
      // Wire format kept from v1 so existing frontend consumers keep working.
      this.gateway?.broadcast("databaseUpdate", event);
    });
  }

  public async connect(): Promise<void> {
    await this.adapter.connect();
    try {
      await this.gateway?.start();
    } catch (err) {
      // Roll back the adapter connection so a failed gateway (e.g. port in
      // use) doesn't leak the pool / listen client.
      await this.adapter.disconnect().catch(() => undefined);
      throw err;
    }
    this.connected = true;
  }

  public async defineModel<T>(
    name: string,
    schema: ModelSchema
  ): Promise<BaseModel<T>> {
    if (!this.connected) {
      throw new ConnectionError("Call connect() before defining models");
    }
    return this.adapter.defineModel<T>(name, schema);
  }

  public async close(): Promise<void> {
    await this.gateway?.stop();
    await this.adapter.disconnect();
    this.connected = false;
  }
}
