import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Native deps that MUST NOT be bundled — they use CommonJS __dirname / require
// internally and break when forced into a single ESM bundle.
// Symptom of forgetting: 'ReferenceError: __dirname is not defined in ES module scope'
// at runtime in the packaged .exe.
const NATIVE_DEPS = [
  'electron',
  'better-sqlite3',
  'node-pty',
  '@homebridge/node-pty-prebuilt-multiarch',
  '@google/genai',
  '@anthropic-ai/sdk',
  'openai',
  '@xenova/transformers',
  'onnxruntime-node',
  // ↑ AI SDKs internally pull in form-data / node-fetch / proxy-agent which
  //   often have __dirname / require.resolve. Safer to keep as external.
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['electron'] })],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(__dirname, 'electron/main.ts'),
        external: NATIVE_DEPS
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ include: ['electron'] })],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'electron/preload.ts'),
          'preload-notification': resolve(__dirname, 'electron/preload-notification.ts')
        },
        external: ['electron']
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
          notification: resolve(__dirname, 'notification.html')
        }
      }
    },
    plugins: [react()]
  }
})
