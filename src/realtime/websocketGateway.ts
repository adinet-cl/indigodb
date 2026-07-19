import WebSocket, { WebSocketServer } from "ws";
import { RealtimeGateway } from "./gateway";
import { Logger, noopLogger } from "../logger";

const HEARTBEAT_INTERVAL_MS = 30_000;

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

export class WebSocketGateway implements RealtimeGateway {
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly port: number,
    private readonly logger: Logger = noopLogger
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

      wss.on("connection", (ws: TrackedSocket) => {
        ws.isAlive = true;
        this.logger.debug("WebSocket client connected");
        ws.on("pong", () => {
          ws.isAlive = true;
        });
        ws.on("error", (err) => {
          this.logger.warn("WebSocket client error", err);
        });
        ws.on("close", () => {
          this.logger.debug("WebSocket client disconnected");
        });
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

  public broadcast(event: string, data: unknown): void {
    if (!this.wss) return;
    const message = JSON.stringify({ event, data });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
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
