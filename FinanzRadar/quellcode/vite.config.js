import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  base: './',
  plugins: [svelte()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
  test: { environment: 'node', include: ['tests/**/*.test.js'], testTimeout: 60000 },
});
