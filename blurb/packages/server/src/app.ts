import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME_BYTES } from '@blurb/shared';
import type { ServerConfig } from './config.js';
import { Relay, type Conn } from './rooms.js';

function remoteIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export async function buildServer(cfg: ServerConfig): Promise<{ app: FastifyInstance; relay: Relay; wss: WebSocketServer }> {
  // Logger off by default: we don't want IPs in log files.
  const app = Fastify({ logger: false, trustProxy: cfg.trustProxy });
  const relay = new Relay(cfg);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: { threshold: 512 } });

  app.get('/healthz', async () => ({ ok: true }));
  app.get<{ Params: { petId: string } }>('/api/pets/:petId', async (req, reply) => {
    const s = relay.publicStatus(req.params.petId);
    if (!s) return reply.code(404).send({ error: 'not found' });
    return s;
  });

  if (cfg.webDist && existsSync(cfg.webDist)) {
    await app.register(fastifyStatic, { root: path.resolve(cfg.webDist), index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const ipKey = relay.ipKey(remoteIp(req, cfg.trustProxy));
    if (!relay.admit(ipKey)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const conn: Conn = {
        ipKey,
        send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
        close: (code, reason) => ws.close(code, reason),
      };
      const h = relay.connect(conn);
      let alive = true;
      ws.on('pong', () => (alive = true));
      const ping = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, 30_000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return ws.close(4002, 'text frames only');
        h.onMessage(data.toString());
      });
      ws.on('close', () => {
        clearInterval(ping);
        relay.release(ipKey);
        h.onClose();
      });
      ws.on('error', () => ws.terminate());
    });
  });

  app.addHook('onClose', async () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });

  return { app, relay, wss };
}
