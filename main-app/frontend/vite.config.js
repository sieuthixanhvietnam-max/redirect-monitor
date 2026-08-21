import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Build thang vao thu muc FastAPI phuc vu.
  build: { outDir: '../app/webui', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8010' } },
});
