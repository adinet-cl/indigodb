/**
 * Strategy contract for real-time transports. The default implementation is
 * WebSocketGateway; alternative transports (SSE, socket.io, ...) only need to
 * implement this interface.
 */
export interface RealtimeGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  broadcast(event: string, data: unknown): void;
}
