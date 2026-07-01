import { ipcMain } from 'electron'
import { getLocalSttStatus, transcribeLocalWav } from '../voice/local-stt'

export type VoiceTranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

export interface VoiceStatusResult {
  ready: boolean
  loading: boolean
  label: string
}

export function registerVoiceIpc(): void {
  // НЕ прогреваем на старте: модель Whisper ~150 МБ (onnxruntime) — грузить её при
  // КАЖДОМ запуске приложения, даже когда голосовой ввод не используется, било по
  // старту и в УПАКОВАННОЙ сборке валило рендерер (краш совпадал с домогрузкой модели).
  // Ленивая загрузка: модель поднимается в transcribeLocalWav при ПЕРВОМ голосовом
  // вводе. voice:status до этого показывает ready=false (кнопка работает, первый ввод
  // включает загрузку). warmLocalStt оставлен экспортом — можно звать по клику на микрофон.
  ipcMain.handle('voice:status', (): VoiceStatusResult => {
    const local = getLocalSttStatus()
    return {
      ready: local.ready,
      loading: local.loading,
      label: local.loading ? 'Загрузка модели…' : 'Голосовой ввод',
    }
  })

  ipcMain.handle('voice:transcribe', async (_e, payload: { data: string; mimeType?: string }) => {
    try {
      if (!payload?.data) {
        return { ok: false, error: 'Нет аудиоданных' } satisfies VoiceTranscribeResult
      }
      const buffer = Buffer.from(payload.data, 'base64')
      if (buffer.length < 256) {
        return { ok: false, error: 'Запись слишком короткая — говорите дольше' } satisfies VoiceTranscribeResult
      }

      const text = await transcribeLocalWav(buffer)
      return { ok: true, text } satisfies VoiceTranscribeResult
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const detail = msg.replace(/^local:\s*/, '')
      if (detail.includes('fetch') || detail.includes('network') || detail.includes('ENOTFOUND')) {
        return {
          ok: false,
          error: 'Не удалось скачать модель (~150 МБ) — нужен интернет при первом запуске',
        } satisfies VoiceTranscribeResult
      }
      if (detail.includes('загруз') || detail.includes('loading')) {
        return {
          ok: false,
          error: 'Модель ещё загружается — подождите 1–2 минуты и повторите',
        } satisfies VoiceTranscribeResult
      }
      return {
        ok: false,
        error: detail.startsWith('local:') ? detail : `Распознавание: ${detail}`,
      } satisfies VoiceTranscribeResult
    }
  })
}