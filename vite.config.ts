import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 静的サーバーのどの階層に置いても動くよう相対パスで出力する
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
