import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['electron'] })],
    build: {
      outDir: 'out/installer',
      rollupOptions: {
        input: resolve(__dirname, 'electron/installer/main.ts'),
        external: ['electron'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ include: ['electron'] })],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          installer: resolve(__dirname, 'electron/installer/preload.ts'),
        },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          installer: resolve(__dirname, 'installer.html'),
        },
      },
    },
    plugins: [react()],
  },
})