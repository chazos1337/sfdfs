import type { ServerEvent } from '@mf/shared';
import { useFactory } from '../store/store';

// Reconnecting WebSocket client. Every (re)connect gets a fresh snapshot from
// the server, so missed events while disconnected are healed automatically.

let socket: WebSocket | null = null;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function url() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connect() {
  if (stopped) return;
  const ws = new WebSocket(url());
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    useFactory.getState().setConnected(true);
  };
  ws.onmessage = (msg) => {
    let e: ServerEvent;
    try {
      e = JSON.parse(String(msg.data)) as ServerEvent;
    } catch {
      return;
    }
    useFactory.getState().applyEvent(e);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    useFactory.getState().setConnected(false);
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  if (stopped || timer) return;
  const delay = Math.min(10_000, 500 * 2 ** retry++);
  timer = setTimeout(() => {
    timer = null;
    connect();
  }, delay);
}

export function startSocket() {
  stopped = false;
  if (!socket && !timer) connect();
}

export function stopSocket() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  socket?.close();
  socket = null;
}
