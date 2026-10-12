import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ cacheDir: '../../node_modules/.cache/statement-web-vite', plugins: [react()], server: { proxy: { '/api': 'http://127.0.0.1:3001' } } });
