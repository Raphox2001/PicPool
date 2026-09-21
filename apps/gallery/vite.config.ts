import { defineConfig } from 'vite';

export default defineConfig({
  base: '/gallery-assets/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2019',
    rollupOptions: {
      output: {
        entryFileNames: 'app.[hash].js',
        assetFileNames: 'app.[hash][extname]',
      },
    },
  },
});
