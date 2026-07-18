/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Stockfish WASM is served as a plain file from public/ and loaded as a
  // classic Worker, so it stays a separate, arm's-length artifact (see
  // docs/decisions/0009-tech-stack.md) and Vite never bundles it.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
