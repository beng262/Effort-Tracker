import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      AUTH_MODE: 'dev',
      CALENDAR_ENABLED: '1',
      SESSION_SECRET: 'test-secret',
      ALLOWED_TENANTS: 'tenant-a:Alpha:alpha.example.com,tenant-b:Beta:beta.example.com',
    },
    testTimeout: 20000,
  },
});
