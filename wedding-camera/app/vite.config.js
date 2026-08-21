import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        guest: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
        gallery: resolve(__dirname, 'gallery/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
