import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// WKWebView からローカルファイルとして読むので base は相対にする
/*
  🔴 どの版が動いているかを画面に出せるようにすること。

     出していなかったので、直したものを渡したあとも
     「本当にそれが動いているのか」がキャプチャから分からず、
     古い版のまま何度も試してもらうことになった（2026-08-30）。
     ビルドした時刻を埋めておけば、画面1枚で分かる。
*/
// 🔴 @types/node は入れないこと（この画面のためだけに依存を増やさない）。
//    手元では他の物のついでに型が入っていて通り、CI の素の環境で落ちた。
declare const process: { env: Record<string, string | undefined> }

const BUILD = process.env.PAC_BUILD || 'v0.0.0-dev'

export default defineConfig({
  define: { __PAC_BUILD__: JSON.stringify(BUILD) },
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
