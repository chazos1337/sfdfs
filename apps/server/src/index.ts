import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { registerRoutes } from './api/routes';
import { config } from './config';
import { initDb, setTimezone } from './db/db';
import { ensureAgents, feed, getSettings, setKv } from './db/repo';
import { callUpstream, closeAll, connectAll, findServerByProfile, resultJson } from './execution/mcpClients';
import { startGateway, stopGateway } from './execution/gateway';
import { startScheduler, stopScheduler } from './pipeline/scheduler';
import { audit } from './safety/audit';
import { registerWs } from './ws/hub';
import { bus } from './bus';
import { hudStats } from './snapshot';

async function refreshWalletBalance() {
  const server = findServerByProfile('paybox');
  if (!server) return;
  try {
    const res = await callUpstream(server, 'get_portfolio', {});
    const data = resultJson(res) as { total_usd?: number | null };
    if (!res.isError && typeof data?.total_usd === 'number') {
      setKv('wallet_balance_usd', data.total_usd);
      bus.publish({ type: 'hud.updated', data: hudStats() });
    }
  } catch {
    // The balance in the HUD just goes stale.
  }
}

async function main() {
  setTimezone(config.TIMEZONE);
  initDb(config.DB_PATH);
  ensureAgents(Math.max(getSettings().worker_count, 1));
  audit('system', 'server_start', null, { auth_mode: config.AUTH_MODE, live_enabled: config.ENABLE_LIVE });

  await startGateway();
  await connectAll();
  void refreshWalletBalance();
  const walletTimer = setInterval(() => void refreshWalletBalance(), 5 * 60_000);

  const app = Fastify({ logger: { level: 'warn' } });
  await app.register(fastifyWebsocket);
  registerWs(app);
  registerRoutes(app);

  // Built frontend for `npm start` (the Vite build copies /assets into it).
  if (fs.existsSync(config.WEB_DIST)) await app.register(fastifyStatic, { root: config.WEB_DIST, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || !fs.existsSync(config.WEB_DIST)) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });

  await app.listen({ port: config.PORT, host: config.HOST });
  const mode = config.AUTH_MODE === 'mock' ? 'MOCK agents ($0)' : config.AUTH_MODE === 'subscription' ? 'Claude Code login (subscription)' : 'API key';
  console.log(`Money Factory on http://${config.HOST}:${config.PORT} · agents: ${mode} · live execution: ${config.ENABLE_LIVE ? 'ENABLED' : 'disabled (paper only)'}`);
  feed('info', `Factory opened. Agents: ${mode}.`);
  startScheduler();

  const shutdown = async () => {
    stopScheduler();
    clearInterval(walletTimer);
    await app.close();
    await stopGateway();
    await closeAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
