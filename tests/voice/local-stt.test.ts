import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  configureLocalSttEnvironment,
  localSttPipelineOptions,
} from '../../electron/voice/local-stt'

function fakeEnvironment() {
  return {
    cacheDir: '',
    allowLocalModels: true,
    backends: { onnx: { wasm: { numThreads: 0 } } },
  }
}

describe('local STT runtime contract', () => {
  it('использует изолированный cache и не подхватывает произвольные local models', () => {
    const env = fakeEnvironment()
    configureLocalSttEnvironment(env, 'C:\\Verstak\\whisper-models', 8)
    expect(env.cacheDir).toBe('C:\\Verstak\\whisper-models')
    expect(env.allowLocalModels).toBe(false)
    expect(env.backends.onnx.wasm.numThreads).toBe(4)
  })

  it('ограничивает ONNX threads безопасным диапазоном', () => {
    const oneCpu = fakeEnvironment()
    configureLocalSttEnvironment(oneCpu, 'cache', 1)
    expect(oneCpu.backends.onnx.wasm.numThreads).toBe(1)

    const manyCpus = fakeEnvironment()
    configureLocalSttEnvironment(manyCpus, 'cache', 64)
    expect(manyCpus.backends.onnx.wasm.numThreads).toBe(4)
  })

  it('просит поддерживаемый q8 dtype вместо удалённого quantized API v2', () => {
    expect(localSttPipelineOptions()).toEqual({ dtype: 'q8' })
  })

  it('packaging держит новый runtime external и распаковывает ONNX native assets', () => {
    const root = resolve(__dirname, '../..')
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      build: { asarUnpack: string[] }
    }
    const viteConfig = readFileSync(resolve(root, 'electron.vite.config.ts'), 'utf8')

    expect(pkg.dependencies['@huggingface/transformers']).toBeTruthy()
    expect(pkg.dependencies['@xenova/transformers']).toBeUndefined()
    expect(pkg.dependencies['onnxruntime-node']).toBeUndefined()
    expect(pkg.build.asarUnpack).toContain('node_modules/onnxruntime-node/**/*')
    expect(viteConfig).toContain("'@huggingface/transformers'")
    expect(viteConfig).not.toContain("'@xenova/transformers'")
  })
})
