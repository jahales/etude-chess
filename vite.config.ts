/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Stockfish WASM is served as a plain file from public/ and loaded as a
  // classic Worker, so it stays a separate, arm's-length artifact (see
  // docs/decisions/0009-tech-stack.md) and Vite never bundles it.
  //
  // Maia (spike): the inference Worker is an ES module worker that imports
  // onnxruntime-web. Excluding ORT from dep pre-bundling keeps its internal
  // dynamic import of the wasm glue a clean runtime string, so it resolves to the
  // self-hosted /ort/ files instead of a Vite-rewritten `?import` URL that 404s.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
  // MAIA_PROBE=1 adds the spike probe page as a build entry, so we can verify the
  // Maia worker + onnxruntime-web wasm bundle for production (they're not yet
  // reachable from the app). Not shipped in a normal build.
  ...(process.env.MAIA_PROBE
    ? { build: { rollupOptions: { input: { main: 'index.html', maiaProbe: 'maia-probe.html' } } } }
    : {}),
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
