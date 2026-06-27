// Tier-2 #5 — create_proof_video: кадры browser-прохода (browser_screenshot) → MP4
// в .verstak/proof/. Видео-доказательство live-проверки веб-сценария для Proof Pack.
import { mkdir } from 'fs/promises'
import { join } from 'path'
import type { ToolHandler } from './shared'
import { emitActivity } from './shared'
import { takeProofFrames } from '../../ai/proof-frames'
import { encodeFramesToMp4 } from '../../ai/frames-to-mp4'

export const createProofVideoHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const frames = takeProofFrames(Number(ctx.sendId))
    if (frames.length === 0) {
      return { id: call.id, name: call.name, result: '', error: 'Нет кадров. Сначала пройди сценарий во вкладке Browser: browser_navigate/browser_click + browser_screenshot на каждом шаге.' }
    }
    const fps = typeof call.args.fps === 'number' && call.args.fps > 0 ? call.args.fps : 1
    const dir = join(ctx.projectPath, '.verstak', 'proof')
    const name = `walkthrough-${Date.now()}.mp4`
    const out = join(dir, name)
    const rel = `.verstak/proof/${name}`
    try {
      await mkdir(dir, { recursive: true })
      const r = await encodeFramesToMp4(frames, out, { fps })
      if (!r.ok) {
        emitActivity(ctx, call, 'error', 'create_proof_video', r.error ?? 'ошибка')
        return { id: call.id, name: call.name, result: '', error: `MP4 не создан: ${r.error}` }
      }
      ctx.recordJournal(ctx.projectPath, 'tool', `Proof-видео: ${frames.length} кадров → ${rel}`, null)
      emitActivity(ctx, call, 'ok', 'create_proof_video', `${frames.length} кадров → ${rel}`)
      return { id: call.id, name: call.name, result: `Proof-видео создано: ${rel} (${frames.length} кадров, ${fps} fps). Это доказательство live-проверки веб-сценария — приложи к отчёту/Proof Pack.` }
    } catch (e) {
      return { id: call.id, name: call.name, result: '', error: e instanceof Error ? e.message : String(e) }
    }
  }
}
