/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_'],
  // Les cartes de sources (7 Mo) ne sont pas embarquées dans l'application livrée.
  build: { target: 'es2022', sourcemap: process.env.SLATE_SOURCEMAP === '1' },
  test: {
    environment: 'jsdom',
    globals: true,
    testTimeout: 20000,
    setupFiles: ['./src/test-setup.ts'],
  },
});
