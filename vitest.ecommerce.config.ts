import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      react: fileURLToPath(
        new URL('./web/node_modules/react', import.meta.url),
      ),
      'react-dom': fileURLToPath(
        new URL('./web/node_modules/react-dom', import.meta.url),
      ),
      'react-router-dom': fileURLToPath(
        new URL('./web/node_modules/react-router-dom', import.meta.url),
      ),
    },
  },
  test: {
    include: [
      'tests/ecommerce-ops/**/*.test.ts',
      'tests/ecommerce-ops/**/*.test.tsx',
      'web/src/components/ecommerce-ops/**/*.test.tsx',
    ],
    maxWorkers: 2,
    testTimeout: 15000,
    exclude: ['**/node_modules/**', '**/dist/**', 'data/**'],
  },
});
