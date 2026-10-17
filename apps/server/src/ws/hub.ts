import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@mf/shared';
import type { WebSocket } from 'ws';
import { bus } from '../bus';
import { hudStats, snapshot } from '../snapshot';

const clients = new Set<WebSocket>();

export function registerWs(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'snapshot', data: snapshot() } satisfies ServerEvent));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  let hudTimer: NodeJS.Timeout | null = null;
  bus.on('event', (e: ServerEvent) => {
    broadcast(e);
    // HUD numbers are derived; recompute at most twice a second.
    if (!hudTimer && e.type !== 'run.event' && e.type !== 'hud.updated')
      hudTimer = setTimeout(() => {
        hudTimer = null;
        broadcast({ type: 'hud.updated', data: hudStats() });
      }, 500);
  });
}

function broadcast(e: ServerEvent) {
  if (!clients.size) return;
  const msg = JSON.stringify(e);
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}
