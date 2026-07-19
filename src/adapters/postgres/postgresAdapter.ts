import { Client, Pool } from "pg";
import { DatabaseAdapter } from "../adapter";
import { PostgresModel } from "./postgresModel";
import { NOTIFICATION_CHANNEL } from "./constants";
import {
  ChangeEvent,
  ModelOptions,
  ModelSchema,
  PostgresConfig,
} from "../../types";
import { ConnectionError, QueryError } from "../../errors";
import { Logger, noopLogger } from "../../logger";

const LISTENER_RETRY_DELAY_MS = 5000;

/**
 * PostgreSQL backend: a Pool serves regular queries while a dedicated Client
 * holds the LISTEN subscription that feeds real-time change events.
 */
export class PostgresAdapter extends DatabaseAdapter {
  private pool?: Pool;
  private listenClient?: Client;
  private closing = false;
  private restartPending = false;

  constructor(
    private readonly config: PostgresConfig,
    private readonly logger: Logger = noopLogger
  ) {
    super();
  }

  public async connect(): Promise<void> {
    this.closing = false;
    this.pool = new Pool(this.connectionOptions());
    this.pool.on("error", (err) => {
      this.logger.error("PostgreSQL pool error", err);
    });
    try {
      // Fail fast on bad credentials/host instead of on the first query.
      await this.pool.query("SELECT 1");
      await this.startListener();
    } catch (err) {
      // Release the pool / listen client if we fail partway through connecting.
      await this.disconnect().catch(() => undefined);
      throw err;
    }
  }

  private connectionOptions() {
    const { connectionString, host, port, user, password, database } =
      this.config;
    return connectionString
      ? { connectionString }
      : { host, port, user, password, database };
  }

  private async startListener(): Promise<void> {
    // Drop any previous (likely errored) client before replacing it, so
    // reconnect cycles don't accumulate abandoned clients and listeners.
    if (this.listenClient) {
      const previous = this.listenClient;
      this.listenClient = undefined;
      previous.removeAllListeners();
      await previous.end().catch(() => undefined);
    }

    const client = new Client(this.connectionOptions());
    this.listenClient = client;

    client.on("error", (err) => {
      this.logger.error("PostgreSQL listen connection error", err);
      this.scheduleListenerRestart();
    });

    client.on("notification", (msg) => {
      if (!msg.payload) return;
      try {
        const event = JSON.parse(msg.payload) as ChangeEvent;
        this.emitChange(event);
      } catch (err) {
        this.logger.warn("Ignoring malformed notification payload", err);
      }
    });

    await client.connect();
    await client.query(`LISTEN ${NOTIFICATION_CHANNEL}`);
    this.logger.debug(`Listening on channel "${NOTIFICATION_CHANNEL}"`);
  }

  private scheduleListenerRestart(): void {
    if (this.closing || this.restartPending) return;
    this.restartPending = true;

    const timer = setTimeout(() => {
      this.restartPending = false;
      if (this.closing) return;
      this.startListener().catch((err) => {
        this.logger.error("Failed to restart PostgreSQL listener", err);
        this.scheduleListenerRestart();
      });
    }, LISTENER_RETRY_DELAY_MS);
    timer.unref();
  }

  public async defineModel<T>(
    name: string,
    schema: ModelSchema,
    options?: ModelOptions
  ): Promise<PostgresModel<T>> {
    if (!this.pool) {
      throw new ConnectionError("PostgresAdapter is not connected");
    }
    const model = new PostgresModel<T>(name, schema, this.pool, options);
    await model.init();
    return model;
  }

  public async raw(query: unknown, params?: unknown[]): Promise<unknown> {
    if (!this.pool) {
      throw new ConnectionError("PostgresAdapter is not connected");
    }
    if (typeof query !== "string") {
      throw new QueryError("PostgreSQL raw() expects a SQL string");
    }
    const result = await this.pool.query(query, params);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  public async disconnect(): Promise<void> {
    this.closing = true;
    if (this.listenClient) {
      await this.listenClient.end().catch((err) => {
        this.logger.warn("Error closing listen connection", err);
      });
      this.listenClient = undefined;
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }
}
