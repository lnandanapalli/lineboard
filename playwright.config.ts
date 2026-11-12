import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    browserName: 'chromium',
    // Roughly a Galaxy Tab A9+ in portrait.
    viewport: { width: 800, height: 1280 },
    hasTouch: true,
    // Request mocks (tests/mockSupabase.ts) can't see requests made by the app's service worker.
    serviceWorkers: 'block',
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
  webServer: {
    // Tests run in local mode (no Supabase), so they need no secrets.
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
