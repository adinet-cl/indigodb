import { RealtimeClient } from "../../src/client/realtimeClient";

class FakeSocket {
  static instances: FakeSocket[] = [];
  listeners = new Map<string, Set<(event?: unknown) => void>>();
  send = jest.fn();
  close = jest.fn();

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;

function lastSocket(): FakeSocket {
  return FakeSocket.instances[FakeSocket.instances.length - 1]!;
}

describe("RealtimeClient", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("connects to the given URL", () => {
    const client = new RealtimeClient({ url: "ws://localhost:8080" });
    client.connect();
    expect(lastSocket().url).toBe("ws://localhost:8080");
  });

  test("sends a subscribe message on open when models/where are set", () => {
    const client = new RealtimeClient({
      url: "ws://x",
      models: ["users"],
      where: { active: true },
    });
    client.connect();
    lastSocket().emit("open");

    expect(lastSocket().send).toHaveBeenCalledWith(
      JSON.stringify({ type: "subscribe", models: ["users"], where: { active: true } })
    );
  });

  test("does not send a subscribe message when no filter is configured", () => {
    const client = new RealtimeClient({ url: "ws://x" });
    client.connect();
    lastSocket().emit("open");
    expect(lastSocket().send).not.toHaveBeenCalled();
  });

  test("dispatches databaseUpdate messages to listeners", () => {
    const client = new RealtimeClient({ url: "ws://x" });
    client.connect();
    const received: unknown[] = [];
    client.on((event) => received.push(event));

    const changeEvent = { model: "users", operation: "INSERT", data: { id: 1 } };
    lastSocket().emit("message", {
      data: JSON.stringify({ event: "databaseUpdate", data: changeEvent }),
    });

    expect(received).toEqual([changeEvent]);
  });

  test("ignores malformed messages and unrelated event types", () => {
    const client = new RealtimeClient({ url: "ws://x" });
    client.connect();
    const received: unknown[] = [];
    client.on((event) => received.push(event));

    expect(() => lastSocket().emit("message", { data: "not json" })).not.toThrow();
    lastSocket().emit("message", { data: JSON.stringify({ event: "other" }) });

    expect(received).toEqual([]);
  });

  test("on() returns an unsubscribe function", () => {
    const client = new RealtimeClient({ url: "ws://x" });
    client.connect();
    const received: unknown[] = [];
    const unsubscribe = client.on((event) => received.push(event));
    unsubscribe();

    lastSocket().emit("message", {
      data: JSON.stringify({
        event: "databaseUpdate",
        data: { model: "users", operation: "INSERT", data: {} },
      }),
    });
    expect(received).toEqual([]);
  });

  test("reconnects with exponential backoff after an unexpected close", () => {
    const client = new RealtimeClient({
      url: "ws://x",
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 1000,
    });
    client.connect();
    expect(FakeSocket.instances).toHaveLength(1);

    lastSocket().emit("close");
    jest.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);

    lastSocket().emit("close");
    jest.advanceTimersByTime(199);
    expect(FakeSocket.instances).toHaveLength(2); // not yet — delay doubled to 200
    jest.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  test("does not reconnect after an intentional close()", () => {
    const client = new RealtimeClient({ url: "ws://x", reconnectDelayMs: 100 });
    client.connect();
    client.close();
    lastSocket().emit("close");
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("close() closes the underlying socket", () => {
    const client = new RealtimeClient({ url: "ws://x" });
    client.connect();
    client.close();
    expect(lastSocket().close).toHaveBeenCalled();
  });

  test("a socket error closes the socket", () => {
    const client = new RealtimeClient({ url: "ws://x" });
    client.connect();
    lastSocket().emit("error");
    expect(lastSocket().close).toHaveBeenCalled();
  });
});
