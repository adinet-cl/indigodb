import type { ChangeEvent } from "../types";

/**
 * The subset of the browser WebSocket API this client needs. Declared
 * locally (instead of depending on the DOM lib) so this module stays
 * framework/runtime-agnostic — it only assumes a global `WebSocket`
 * constructor exists wherever it runs (any modern browser, or Node 22+).
 */
interface MinimalWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void
  ): void;
}
declare const WebSocket: { new (url: string): MinimalWebSocket };

export interface RealtimeClientOptions {
  /** WebSocket URL of an IndigoDB realtime gateway, e.g. "ws://localhost:8080". */
  url: string;
  /** Restrict delivery to these model names. Omit to receive every model. */
  models?: string[];
  /** Server-side filter: only ChangeEvents whose `data` matches are delivered. */
  where?: Record<string, unknown>;
  /** Initial reconnect delay in ms after an unexpected disconnect. Default 1000. */
  reconnectDelayMs?: number;
  /** Reconnect delay cap in ms; doubles after each attempt up to this. Default 30000. */
  maxReconnectDelayMs?: number;
}

export type RealtimeListener = (event: ChangeEvent) => void;

/**
 * Minimal, dependency-free real-time client: connects, sends the
 * subscribe filter declared in `options`, re-subscribes automatically after
 * a reconnect, and backs off exponentially between reconnect attempts.
 */
export class RealtimeClient {
  private socket?: MinimalWebSocket;
  private readonly listeners = new Set<RealtimeListener>();
  private reconnectDelay: number;
  private closedByUser = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: RealtimeClientOptions) {
    this.reconnectDelay = options.reconnectDelayMs ?? 1000;
  }

  public connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelay = this.options.reconnectDelayMs ?? 1000;
      if (this.options.models || this.options.where) {
        socket.send(
          JSON.stringify({
            type: "subscribe",
            models: this.options.models,
            where: this.options.where,
          })
        );
      }
    });

    socket.addEventListener("message", (raw) => {
      let message: { event?: string; data?: ChangeEvent };
      try {
        message = JSON.parse(String(raw.data));
      } catch {
        return;
      }
      if (message.event === "databaseUpdate" && message.data) {
        for (const listener of this.listeners) listener(message.data);
      }
    });

    socket.addEventListener("close", () => {
      if (!this.closedByUser) this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    const max = this.options.maxReconnectDelayMs ?? 30_000;
    this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, max);
  }

  /** Subscribes to change events; returns an unsubscribe function. */
  public on(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}
