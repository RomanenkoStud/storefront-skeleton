import { defineConfig } from '@playwright/test';
const port = Number(process.env.E2E_PORT || 8788);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: origin,
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npx wrangler d1 migrations apply DB --local -c tests/e2e/wrangler.e2e.jsonc --persist-to .wrangler/e2e && npx wrangler dev -c tests/e2e/wrangler.e2e.jsonc --persist-to .wrangler/e2e --port ${port} --ip 127.0.0.1 --var AUTH_DEV_BYPASS:true --var APP_ENV:development`,
    url: `${origin}/api/health`,
    timeout: 120000,
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: 'false' },
  },
});
