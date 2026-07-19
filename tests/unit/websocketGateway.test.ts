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
  return (gateway as never as { wss: { clients: Set<FakeClient>; closed: boolean } }).wss;
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
});
