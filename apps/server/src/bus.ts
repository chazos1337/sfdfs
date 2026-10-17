import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@mf/shared';

// In-process event bus. Everything that changes state emits here; the
// WebSocket hub forwards every event to connected browsers.
class Bus extends EventEmitter {
  publish(event: ServerEvent) {
    this.emit('event', event);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
