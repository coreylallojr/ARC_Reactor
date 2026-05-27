// @ts-check
'use strict';
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir:       './tests',
  fullyParallel: true,
  forbidOnly:    !!process.env.CI,
  retries:       process.env.CI ? 2 : 1,
  workers:       process.env.CI ? 1 : 4,
  reporter:      [['html', { open: 'never' }], ['list']],
  timeout:       30000,

  use: {
    baseURL:         'http://localhost:7474',
    trace:           'on-first-retry',
    headless:        true,
    screenshot:      'on',
    video:           'retain-on-failure',
    actionTimeout:   10000,
    navigationTimeout: 20000,
  },

  projects: [
    {
      name:    'chromium',
      use:     { ...devices['Desktop Chrome'] },
    },
  ],

  globalSetup:    './tests/global-setup.js',
  globalTeardown: './tests/global-teardown.js',

  webServer: [
    {
      command:             'node Neural/scripts/neural-ui-server.js',
      url:                 'http://localhost:7474/api/status',
      timeout:             25000,
      reuseExistingServer: !process.env.CI,
      stdout:              'pipe',
      stderr:              'pipe',
      env: { ...process.env, JARVIS_TEST: '1' },
    },
    {
      command:             'node Neural/scripts/jarvis-api-server.js',
      url:                 'http://localhost:7476/v1/status',
      timeout:             15000,
      reuseExistingServer: !process.env.CI,
      stdout:              'pipe',
      stderr:              'pipe',
      env: { ...process.env, JARVIS_TEST: '1' },
    },
  ],
});
