/** Thin WebSocket wrapper: JSON in, JSON out, plus a "we're dead" callback. */

export class Net {
  constructor() {
    this.socket = null;
    this.handlers = new Map();
    this.onDown = () => {};
    this._queue = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${scheme}://${location.host}/ws`);
      this.socket = socket;

      socket.addEventListener('open', () => {
        for (const message of this._queue.splice(0)) socket.send(message);
        resolve();
      });
      socket.addEventListener('error', () => reject(new Error('Could not reach the ship.')));
      socket.addEventListener('close', () => this.onDown());
      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        this.handlers.get(message.t)?.(message);
      });
    });
  }

  on(type, handler) {
    this.handlers.set(type, handler);
    return this;
  }

  send(type, payload = {}) {
    const message = JSON.stringify({ t: type, ...payload });
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
    else this._queue.push(message);
  }
}
