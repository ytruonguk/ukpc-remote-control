import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { deeplinkRedirect } from './deeplink-redirect';

export default defineConfig({
  plugins: [react(), deeplinkRedirect()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
