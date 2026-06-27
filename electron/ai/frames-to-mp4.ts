/**
 * Tier-2 #5 — кодирование PNG-кадров (скриншоты browser-прохода) в MP4 через ffmpeg.
 * Для Proof: live-проверка веб-сценария → видео-доказательство в Proof Pack.
 *
 * Graceful: ffmpeg не найден / нет кадров / ошибка → { ok:false }. НИКОГДА не кидает.
 * ffmpeg ищется: FFMPEG_PATH → PATH → winget (Gyan.FFmpeg) на Windows.
 */

import { spawn, execSync } from 'child_process'
import { writeFile, mkdtemp, rm } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let ffmpegCache: string | null = null

export function resolveFfmpeg(): string | null {
  // Кэшируем ТОЛЬКО найденный путь; промах перепроверяем (ffmpeg могли поставить
  // во время сессии — иначе null залипал бы до перезапуска, ревью 26.06).
  if (ffmpegCache) return ffmpegCache
  ffmpegCache = doResolveFfmpeg()
  return ffmpegCache
}

function doResolveFfmpeg(): string | null {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'command -v ffmpeg'
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0]
    if (out && existsSync(out)) return out
  } catch { /* не в PATH */ }
  // Windows winget: %LOCALAPPDATA%/Microsoft/WinGet/Packages/Gyan.FFmpeg*/…/bin/ffmpeg.exe
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    try {
      const base = join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
      for (const pkg of readdirSync(base)) {
        if (!/ffmpeg/i.test(pkg)) continue
        const pkgDir = join(base, pkg)
        for (const sub of readdirSync(pkgDir)) {
          const exe = join(pkgDir, sub, 'bin', 'ffmpeg.exe')
          if (existsSync(exe)) return exe
        }
      }
    } catch { /* нет winget */ }
  }
  return null
}

function runFfmpeg(bin: string, args: string[]): Promise<number> {
  return new Promise(resolve => {
    const p = spawn(bin, args, { stdio: 'ignore', windowsHide: true })
    p.on('error', () => resolve(-1))
    p.on('exit', code => resolve(code ?? -1))
  })
}

/** Закодировать PNG-кадры (Buffer[]) в MP4 по outPath. fps — кадров/сек (default 1). */
export async function encodeFramesToMp4(
  frames: Buffer[],
  outPath: string,
  opts?: { fps?: number },
): Promise<{ ok: boolean; error?: string }> {
  if (!frames || frames.length === 0) return { ok: false, error: 'нет кадров' }
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) return { ok: false, error: 'ffmpeg не найден (установи ffmpeg или задай FFMPEG_PATH)' }

  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'verstak-mp4-'))
    for (let i = 0; i < frames.length; i++) {
      await writeFile(join(dir, `f-${String(i).padStart(4, '0')}.png`), frames[i])
    }
    const fps = opts?.fps && opts.fps > 0 ? opts.fps : 1
    const args = [
      '-y', '-framerate', String(fps),
      '-i', join(dir, 'f-%04d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      // паддинг до чётных размеров (yuv420p требует) — иначе ffmpeg падает
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      outPath,
    ]
    const code = await runFfmpeg(ffmpeg, args)
    if (code !== 0) return { ok: false, error: `ffmpeg завершился с кодом ${code}` }
    if (!existsSync(outPath)) return { ok: false, error: 'ffmpeg не создал файл' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
