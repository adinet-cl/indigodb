jest.mock("ws", () => {
  const { EventEmitter } = require("node:events");

  class MockWebSocketServer extends EventEmitter {
    clients = new Set();
    closed = false;
    constructor() {
      super();
      setImmediate(() => this.emit("listening"));
    }
    close(cb?: () => void) {
      this.closed = true;
      cb?.();
    }
  }

  const MockWebSocket = { OPEN: 1, CLOSED: 3 };

  return {
    __esModule: true,
    default: MockWebSocket,
    WebSocketServer: MockWebSocketServer,
    Server: MockWebSocketServer,
  };
});

import { EventEmitter } from "node:events";
import { WebSocketGateway } from "../../src/realtime/websocketGateway";

interface FakeClient {
  readyState: number;
  send: jest.Mock;
  terminate: jest.Mock;
  ping: jest.Mock;
  isAlive?: boolean;
}

function makeClient(readyState = 1): FakeClient {
  return {
    readyState,
    send: jest.fn(),
    terminate: jest.fn(),
    ping: jest.fn(),
  };
}

function serverOf(gateway: WebSocketGateway) {
  return (
    gateway as never as {
      wss: { clients: Set<FakeClient>; closed: boolean } & EventEmitter;
    }
  ).wss;
}

class ConnectableClient extends EventEmitter {
  readyState = 1;
  send = jest.fn();
  terminate = jest.fn();
  ping = jest.fn();
  close = jest.fn();
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("WebSocketGateway", () => {
  test("start resolves once the server is listening", async () => {
    const gateway = new WebSocketGateway(0);
    await expect(gateway.start()).resolves.toBeUndefined();
    await gateway.stop();
  });

  test("broadcast sends the JSON envelope to OPEN clients only", async () => {
    const gateway = new WebSocketGateway(0);
    await gateway.start();

    const open = makeClient(1);
    const closed = makeClient(3);
    serverOf(gateway).clients.add(open);
    serverOf(gateway).clients.add(closed);

    const data = { model: "users", operation: "INSERT", data: { id: 1 } };
    gateway.broadcast("databaseUpdate", data);

    expect(open.send).toHaveBeenCalledWith(
      JSON.stringify({ event: "databaseUpdate", data })
    );
    expect(closed.send).not.toHaveBeenCalled();

    await gateway.stop();
  });

  test("broadcast before start is a no-op", () => {
    const gateway = new WebSocketGateway(0);
    expect(() => gateway.broadcast("databaseUpdate", {})).not.toThrow();
  });

  test("stop terminates clients and closes the server", async () => {
    const gateway = new WebSocketGateway(0);
    await gateway.start();

    const client = makeClient(1);
    const server = serverOf(gateway);
    server.clients.add(client);

    await gateway.stop();

    expect(client.terminate).toHaveBeenCalled();
    expect(server.closed).toBe(true);
  });

  test("stop is safe to call before start", async () => {
    const gateway = new WebSocketGateway(0);
    await expect(gateway.stop()).resolves.toBeUndefined();
  });

  describe("authenticate", () => {
    test("accepts the connection when authenticate() resolves true", async () => {
      const authenticate = jest.fn().mockResolvedValue(true);
      const gateway = new WebSocketGateway(0, undefined, authenticate);
      await gateway.start();

      const client = new ConnectableClient();
      serverOf(gateway).emit("connection", client, { headers: {} });
      await flushMicrotasks();

      expect(authenticate).toHaveBeenCalledWith({ headers: {} });
      expect(client.close).not.toHaveBeenCalled();

      await gateway.stop();
    });

    test("closes the connection with 4001 when authenticate() resolves false", async () => {
      const authenticate = jest.fn().mockResolvedValue(false);
      const gateway = new WebSocketGateway(0, undefined, authenticate);
      await gateway.start();

      const client = new ConnectableClient();
      serverOf(gateway).emit("connection", client, { headers: {} });
      await flushMicrotasks();

      expect(client.close).toHaveBeenCalledWith(4001, "Unauthorized");

      await gateway.stop();
    });

    test("refuses the connection when authenticate() throws", async () => {
      const authenticate = jest.fn().mockRejectedValue(new Error("boom"));
      const gateway = new WebSocketGateway(0, undefined, authenticate);
      await gateway.start();

      const client = new ConnectableClient();
      serverOf(gateway).emit("connection", client, { headers: {} });
      await flushMicrotasks();

      expect(client.close).toHaveBeenCalledWith(4001, "Unauthorized");

      await gateway.stop();
    });

    test("no authenticate hook accepts every connection", async () => {
      const gateway = new WebSocketGateway(0);
      await gateway.start();

      const client = new ConnectableClient();
      serverOf(gateway).emit("connection", client, { headers: {} });
      await flushMicrotasks();

      expect(client.close).not.toHaveBeenCalled();
      await gateway.stop();
    });
  });

  describe("filtered subscriptions", () => {
    async function connectedClient(gateway: WebSocketGateway) {
      const client = new ConnectableClient();
      const server = serverOf(gateway);
      // The real `ws` library adds accepted sockets to wss.clients itself;
      // the mock doesn't, so tests that broadcast() need it added explicitly.
      server.clients.add(client);
      server.emit("connection", client, { headers: {} });
      await flushMicrotasks();
      return client;
    }

    test("a client with no subscription receives every event (back-compat)", async () => {
      const gateway = new WebSocketGateway(0);
      await gateway.start();
      const client = await connectedClient(gateway);

      gateway.broadcast("databaseUpdate", {
        model: "users",
        operation: "INSERT",
        data: { id: 1 },
      });

      expect(client.send).toHaveBeenCalledTimes(1);
      await gateway.stop();
    });

    test("subscribing to specific models filters out the rest", async () => {
      const gateway = new WebSocketGateway(0);
      await gateway.start();
      const client = await connectedClient(gateway);

      client.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", models: ["users"] }))
      );

      gateway.broadcast("databaseUpdate", {
        model: "orders",
        operation: "INSERT",
        data: { id: 1 },
      });
      expect(client.send).not.toHaveBeenCalled();

      gateway.broadcast("databaseUpdate", {
        model: "users",
        operation: "INSERT",
        data: { id: 2 },
      });
      expect(client.send).toHaveBeenCalledTimes(1);

      await gateway.stop();
    });

    test("subscribing with a where filter only delivers matching events", async () => {
      const gateway = new WebSocketGateway(0);
      await gateway.start();
      const client = await connectedClient(gateway);

      client.emit(
        "message",
        Buffer.from(
          JSON.stringify({ type: "subscribe", where: { status: "urgent" } })
        )
      );

      gateway.broadcast("databaseUpdate", {
        model: "tickets",
        operation: "UPDATE",
        data: { id: 1, status: "normal" },
      });
      expect(client.send).not.toHaveBeenCalled();

      gateway.broadcast("databaseUpdate", {
        model: "tickets",
        operation: "UPDATE",
        data: { id: 2, status: "urgent" },
      });
      expect(client.send).toHaveBeenCalledTimes(1);

      await gateway.stop();
    });

    test("a later subscribe message replaces the previous one", async () => {
      const gateway = new WebSocketGateway(0);
      await gateway.start();
      const client = await connectedClient(gateway);

      client.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", models: ["users"] }))
      );
      client.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", models: ["orders"] }))
      );

      gateway.broadcast("databaseUpdate", {
        model: "users",
        operation: "INSERT",
        data: { id: 1 },
      });
      expect(client.send).not.toHaveBeenCalled();

      gateway.broadcast("databaseUpdate", {
        model: "orders",
        operation: "INSERT",
        data: { id: 1 },
      });
      expect(client.send).toHaveBeenCalledTimes(1);

      await gateway.stop();
    });

    test("malformed subscribe messages are ignored, not thrown", async () => {
      const gateway = new WebSocketGateway(0);
      await gateway.start();
      const client = await connectedClient(gateway);

      expect(() =>
        client.emit("message", Buffer.from("not json"))
      ).not.toThrow();
      expect(() =>
        client.emit("message", Buffer.from(JSON.stringify({ type: "ping" })))
      ).not.toThrow();

      gateway.broadcast("databaseUpdate", {
        model: "users",
        operation: "INSERT",
        data: { id: 1 },
      });
      expect(client.send).toHaveBeenCalledTimes(1);

      await gateway.stop();
    });

    test("filtering only applies to ChangeEvent-shaped payloads", async () => {
      const gateway = new WebSocketGateway(0);
      await gateway.start();
      const client = await connectedClient(gateway);

      client.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", models: ["users"] }))
      );

      gateway.broadcast("customEvent", { not: "a change event" });
      expect(client.send).toHaveBeenCalledTimes(1);

      await gateway.stop();
    });
  });
});
