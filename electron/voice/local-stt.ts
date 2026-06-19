import { app } from 'electron'
import { cpus } from 'os'
import { join } from 'path'
import { decodeWavToFloat32 } from './wav-decode'

/** tiny ≈40% ошибок на русском; small — заметно точнее (~150 МБ квант.) */
const MODEL_ID = 'Xenova/whisper-small'
const MODEL_LABEL = 'Whisper small'

type AsrResult = { text?: string }
type AsrPipeline = (
  audio: Float32Array,
  opts?: Record<string, unknown>,
) => Promise<AsrResult>

let pipelinePromise: Promise<AsrPipeline> | null = null
let loadError: string | null = null
let loading = false

export function getLocalSttStatus(): { available: boolean; ready: boolean; loading: boolean; error: string | null; model: string } {
  return {
    available: true,
    ready: Boolean(pipelinePromise) && !loadError && !loading,
    loading,
    error: loadError,
    model: MODEL_LABEL,
  }
}

/** Прогрев модели (~150 МБ, один раз при первом использовании). */
export function warmLocalStt(): void {
  void getTranscriber().catch(() => { /* статус в getLocalSttStatus */ })
}

async function getTranscriber(): Promise<AsrPipeline> {
  if (pipelinePromise && !loadError) return pipelinePromise
  loading = true
  loadError = null
  pipelinePromise = (async () => {
    const { env, pipeline } = await import('@xenova/transformers')
    env.cacheDir = join(app.getPath('userData'), 'whisper-models')
    env.allowLocalModels = false
    env.backends.onnx.wasm.numThreads = Math.min(4, Math.max(1, cpus().length - 1))
    const pipe = await pipeline('automatic-speech-recognition', MODEL_ID, { quantized: true })
    loading = false
    return pipe as AsrPipeline
  })().catch((err: unknown) => {
    loading = false
    loadError = err instanceof Error ? err.message : String(err)
    pipelinePromise = null
    throw err
  })
  return pipelinePromise
}

export async function transcribeLocalWav(buffer: Buffer): Promise<string> {
  const transcriber = await getTranscriber()
  const audio = decodeWavToFloat32(buffer, 16000)
  if (audio.length < 1600) throw new Error('local: слишком короткая запись')

  const result = await transcriber(audio, {
    language: 'russian',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
    temperature: 0,
    condition_on_previous_text: false,
    initial_prompt: 'Диктовка на русском языке.',
  })

  const text = (result?.text ?? '').trim()
  if (!text) throw new Error('local: пустой ответ')
  return text
}