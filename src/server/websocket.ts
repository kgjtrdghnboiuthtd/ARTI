import type { EventBus } from "../core/events.ts";
import type { ArctiEvents } from "../core/types.ts";
import { logger } from "../observability/logger.ts";

const log = logger.child("ws");

interface WSClient {
  send(data: string): void;
  readyState: number;
}

const clients = new Set<WSClient>();

/**
 * Attach WebSocket event broadcasting to the event bus.
 * All Arcti events are forwarded to connected WS clients.
 */
export function attachWebSocket(events: EventBus): void {
  const forward = <K extends keyof ArctiEvents>(event: K) => {
    events.on(event, (data) => {
      broadcast(event, data);
    });
  };

  forward("project:created");
  forward("task:created");
  forward("task:started");
  forward("task:completed");
  forward("task:failed");
  forward("task:verified");
  forward("task:decomposed");
  forward("task:stream-chunk");
  forward("task:feedback-request");
  forward("task:user-feedback");
  forward("project:intake-start");
  forward("project:intake-questions");
  forward("project:intake-done");
  forward("project:complete");
  forward("project:aborted");
  forward("llm:call");
  forward("llm:response");
}

function broadcast(event: string, data: unknown): void {
  const msg = JSON.stringify({ event, data, timestamp: Date.now() });

  for (const client of clients) {
    if (client.readyState === 1) {
      // OPEN
      try {
        client.send(msg);
      } catch {
        clients.delete(client);
      }
    } else {
      clients.delete(client);
    }
  }
}

/**
 * Handle a new WebSocket upgrade (for Bun's native WS server).
 */
export function handleWSConnection(ws: WSClient): void {
  clients.add(ws);
  log.info("WebSocket client connected", { total: clients.size });

  ws.send(
    JSON.stringify({
      event: "connected",
      data: { message: "Connected to Arcti" },
      timestamp: Date.now(),
    }),
  );
}

export function handleWSClose(ws: WSClient): void {
  clients.delete(ws);
  log.info("WebSocket client disconnected", { total: clients.size });
}
