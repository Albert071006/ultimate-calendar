import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globalSetup: ['./tests/setup-backup-worker.mjs'] } });
