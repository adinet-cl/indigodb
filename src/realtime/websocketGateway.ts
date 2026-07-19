import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { RealtimeGateway } from "./gateway";
import { Logger, noopLogger } from "../logger";
import { matchesWhere } from "./matchesWhere";
import { ChangeEvent } from "../types";

const HEARTBEAT_INTERVAL_MS = 30_000;
/** ws close code for policy violations (RFC 6455 reserves 4000-4999 for apps). */
const UNAUTHORIZED_CLOSE_CODE = 4001;

export type AuthenticateConnection = (
  request: IncomingMessage
) => boolean | Promise<boolean>;

interface ClientSubscription {
  /** Only these model names are delivered. Omit to receive every model. */
  models?: Set<string>;
  /** Only events whose `data` matches this Where tree are delivered. */
  where?: Record<string, unknown>;
}

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
  /** Replaced wholesale by the client's most recent "subscribe" message. */
  subscription?: ClientSubscription;
}

function isChangeEvent(value: unknown): value is ChangeEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    "model" in value &&
    "operation" in value &&
    "data" in value
  );
}

export class WebSocketGateway implements RealtimeGateway {
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly port: number,
    private readonly logger: Logger = noopLogger,
    private readonly authenticate?: AuthenticateConnection
  ) {}

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.port });
      this.wss = wss;

      wss.on("listening", () => {
        this.logger.info(`WebSocket server listening on port ${this.port}`);
        resolve();
      });

      wss.on("error", (err) => {
        this.logger.error("WebSocket server error", err);
        reject(err);
      });

      wss.on("connection", (ws: TrackedSocket, request: IncomingMessage) => {
        void this.handleConnection(ws, request);
      });

      this.heartbeat = setInterval(() => {
        for (const client of wss.clients as Set<TrackedSocket>) {
          if (client.isAlive === false) {
            client.terminate();
            continue;
          }
          client.isAlive = false;
          client.ping();
        }
      }, HEARTBEAT_INTERVAL_MS);
      this.heartbeat.unref();
    });
  }

  private async handleConnection(
    ws: TrackedSocket,
    request: IncomingMessage
  ): Promise<void> {
    if (this.authenticate) {
      let authorized: boolean;
      try {
        authorized = await this.authenticate(request);
      } catch (err) {
        this.logger.warn("WebSocket authenticate() threw; refusing connection", err);
        authorized = false;
      }
      if (!authorized) {
        this.logger.debug("WebSocket connection refused by authenticate()");
        ws.close(UNAUTHORIZED_CLOSE_CODE, "Unauthorized");
        return;
      }
    }

    ws.isAlive = true;
    this.logger.debug("WebSocket client connected");
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("message", (raw) => this.handleMessage(ws, raw));
    ws.on("error", (err) => {
      this.logger.warn("WebSocket client error", err);
    });
    ws.on("close", () => {
      this.logger.debug("WebSocket client disconnected");
    });
  }

  /**
   * Only understands `{ type: "subscribe", models?, where? }`. Anything else
   * (malformed JSON, unknown message types) is silently ignored — client
   * input is never trusted enough to throw or disconnect over.
   */
  private handleMessage(ws: TrackedSocket, raw: WebSocket.RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (
      message === null ||
      typeof message !== "object" ||
      (message as { type?: unknown }).type !== "subscribe"
    ) {
      return;
    }

    const { models, where } = message as { models?: unknown; where?: unknown };
    ws.subscription = {
      models:
        Array.isArray(models) && models.every((m) => typeof m === "string")
          ? new Set(models as string[])
          : undefined,
      where:
        where !== null && typeof where === "object"
          ? (where as Record<string, unknown>)
          : undefined,
    };
  }

  private matchesSubscription(
    subscription: ClientSubscription | undefined,
    data: unknown
  ): boolean {
    // No subscription sent yet: back-compat default is "receive everything".
    if (!subscription) return true;
    if (!isChangeEvent(data)) return true;
    if (subscription.models && !subscription.models.has(data.model)) return false;
    if (
      subscription.where &&
      !matchesWhere(data.data as Record<string, unknown>, subscription.where)
    ) {
      return false;
    }
    return true;
  }

  public broadcast(event: string, data: unknown): void {
    if (!this.wss) return;
    const message = JSON.stringify({ event, data });
    for (const client of this.wss.clients as Set<TrackedSocket>) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (!this.matchesSubscription(client.subscription, data)) continue;
      client.send(message);
    }
  }

  public stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    const wss = this.wss;
    this.wss = undefined;
    if (!wss) return Promise.resolve();

    for (const client of wss.clients) {
      client.terminate();
    }
    return new Promise((resolve) => wss.close(() => resolve()));
  }
}
