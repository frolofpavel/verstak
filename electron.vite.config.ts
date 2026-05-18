import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    build: { outDir: 'out/main', rollupOptions: { input: resolve(__dirname, 'electron/main.ts') } }
  },
  preload: {
    build: { outDir: 'out/preload', rollupOptions: { input: resolve(__dirname, 'electron/preload.ts') } }
  },
  renderer: {
    root: '.',
    build: { outDir: 'out/renderer', rollupOptions: { input: resolve(__dirname, 'index.html') } },
    plugins: [react()]
  }
})
