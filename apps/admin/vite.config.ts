import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/admin-assets/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      output: {
        entryFileNames: 'app.[hash].js',
        assetFileNames: 'app.[hash][extname]',
      },
    },
  },
});
