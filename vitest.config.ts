import { defineConfig } from 'vitest/config';

// Server tests. apps/server/src/config.ts reads the environment at import
// time, so everything it needs is set here. Each test file runs in its own
// forked process so module-level state (db handle, gateway, upstream MCP
// clients, budget clock-out) never leaks between files.
export default defineConfig({
  test: {
    include: ['apps/server/test/**/*.test.ts'],
    pool: 'forks',
    isolate: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      MOCK_AGENTS: '1',
      MOCK_SPEED: '50',
      ENABLE_LIVE: 'false',
      // Never pick up a real config/mcp.json: in mock mode a missing file
      // means connectAll() spawns the bundled fake PayBox + AgentMail.
      MCP_CONFIG: 'config/__vitest_no_such_file__.json',
      // Unused: tests call initDb(':memory:') themselves.
      DB_PATH: 'data/__vitest_unused__.db',
      NTFY_URL: '',
      DAILY_API_BUDGET_USD: '5',
      PER_RUN_BUDGET_USD: '0.75',
      WORKER_COUNT: '2',
      PER_ACTION_CAP_USD: '10',
      DAILY_SPEND_CAP_USD: '50',
      DAILY_EMAIL_CAP: '20',
    },
  },
});
