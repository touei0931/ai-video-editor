import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: { output: { format: 'es', entryFileNames: 'index.js' } },
          },
        },
      },
      preload: {
        input: 'electron/preload/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            // preload は CJS で出す（contextIsolation 有効時に扱いが素直なため）
            rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
          },
        },
      },
    }),
  ],
});
