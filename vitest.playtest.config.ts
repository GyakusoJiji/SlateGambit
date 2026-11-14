import { defineConfig } from 'vitest/config';

// バランス検証用の自動対戦(通常のテストとは分けて実行する)
export default defineConfig({
  test: {
    include: ['tools/**/*.sim.ts'],
    testTimeout: 600_000,
  },
});
