import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  // 配布時は file:// で index.html を読むので、絶対パス参照だとドライブ直下を見に行ってしまう。
  base: './',
  // 同梱フォント（SIL OFL）を ./fonts/... で参照できるようにする。
  // テロップ描画はフォントが載ってからでないと見た目が変わるので、配置場所は固定しておく。
  publicDir: 'assets',
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
