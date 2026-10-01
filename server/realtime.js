// Server-Sent Events: één open verbinding per tabblad, berichten per gebruiker.
class Realtime {
  constructor() {
    this.clients = new Map();
  }

  connect(userId, req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    if (!this.clients.has(userId)) this.clients.set(userId, new Set());
    const set = this.clients.get(userId);
    set.add(res);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (set.size === 0) this.clients.delete(userId);
    });
  }

  isConnected(userId) {
    return this.clients.has(userId);
  }

  send(userId, type, data) {
    const set = this.clients.get(userId);
    if (!set) return;
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(payload);
  }
}

module.exports = { Realtime };
