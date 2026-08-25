import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// WKWebView からローカルファイルとして読むので base は相対にする
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // パネル内で読むだけなので分割しない方が確実
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: { port: 5178 },
})
