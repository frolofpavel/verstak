import { defineConfig } from 'vite'
export default defineConfig({
  build: {
    ssr: 'mobile/relay/server.ts',
    outDir: 'out/mobile-relay',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'server.mjs' } },
  },
})
