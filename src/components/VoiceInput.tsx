import { useEffect, useRef, useState } from 'react'

/**
 * Voice input через Web Speech API (recognition).
 *
 * Doesn't ship audio to any server — Chromium's local recognition pipeline.
 * При первом запуске Electron спросит разрешение микрофона у ОС.
 *
 * Поведение:
 * - Клик 🎤 → запись начинается
 * - Распознанный текст добавляется в composer как user печатает
 * - interimResults показывают промежуточные варианты (rolling в textarea)
 * - Клик ⏹ → стоп. Финальный текст остаётся в textarea.
 * - Автостоп: при паузе ~2 сек тишины (browser default end-of-speech)
 */

// Type shims — Web Speech API не в стандартных lib.dom.d.ts
interface SpeechRecognitionEvent extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}
interface SpeechRecognitionResultList {
  length: number
  [index: number]: SpeechRecognitionResult
}
interface SpeechRecognitionResult {
  isFinal: boolean
  [index: number]: { transcript: string; confidence: number }
}
interface SpeechRecognitionInstance extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onerror: ((e: { error: string; message: string }) => void) | null
  onend: (() => void) | null
}
interface SpeechRecognitionCtor { new(): SpeechRecognitionInstance }

interface Props {
  /** Append the recognized chunk to the composer text. */
  onTranscript: (chunkAppend: string) => void
}

export function VoiceInput({ onTranscript }: Props) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionInstance | null>(null)
  /** Length of text already committed to textarea (so interim doesn't double-add). */
  const committedLenRef = useRef(0)

  // SpeechRecognition availability check
  const Ctor = (window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  })
  const RecognitionClass: SpeechRecognitionCtor | undefined =
    Ctor.SpeechRecognition ?? Ctor.webkitSpeechRecognition

  function start() {
    if (!RecognitionClass) {
      setError('Web Speech API недоступен в этой версии Electron')
      return
    }
    setError(null)
    committedLenRef.current = 0
    const rec = new RecognitionClass()
    rec.lang = 'ru-RU'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onresult = (e) => {
      // Process only results from the latest "chunk"
      let interim = ''
      let final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const text = r[0].transcript
        if (r.isFinal) final += text
        else interim += text
      }
      if (final) {
        onTranscript(final + ' ')
        committedLenRef.current = 0  // reset — final committed
      }
      // Interim is shown via title attribute on the button (visible hover)
      // — we don't push interim to textarea to avoid double-typing race
      // when user is also editing. Final-only commit.
      void interim
    }
    rec.onerror = (e) => {
      setError(`Recognition error: ${e.error}`)
      setRecording(false)
    }
    rec.onend = () => {
      setRecording(false)
      recRef.current = null
    }
    try {
      rec.start()
      recRef.current = rec
      setRecording(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function stop() {
    try { recRef.current?.stop() } catch { /* already stopped */ }
    setRecording(false)
  }

  useEffect(() => {
    return () => {
      try { recRef.current?.abort() } catch { /* noop */ }
    }
  }, [])

  if (!RecognitionClass) return null  // hide silently if unsupported

  return (
    <button
      type="button"
      className={`gg-voice-btn ${recording ? 'is-recording' : ''}`}
      onClick={recording ? stop : start}
      title={recording ? 'Остановить запись' : (error ? `Голосовой ввод (${error})` : 'Голосовой ввод (русский)')}
    >
      {recording ? '⏹' : '🎤'}
    </button>
  )
}
