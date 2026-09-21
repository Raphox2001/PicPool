import { defineConfig } from 'vite';

export default defineConfig({
  // Die Seite wird unter /u/<token> ausgeliefert. Relative Pfade sorgen
  // dafuer, dass die Assets unabhaengig von der Tokenlaenge gefunden werden.
  base: '/upload-assets/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Aeltere Handys sind hier die Zielgruppe, nicht die neuesten Browser.
    target: 'es2017',
    rollupOptions: {
      output: {
        entryFileNames: 'app.[hash].js',
        assetFileNames: 'app.[hash][extname]',
      },
    },
  },
});
