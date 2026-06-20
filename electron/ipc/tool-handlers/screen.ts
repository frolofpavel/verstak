// Screen-хендлеры: screen_capture / screen_info. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity } from './shared'

export const screenCaptureHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      // desktopCapturer and screen are Electron main-process APIs — they are
      // not available in Node.js / vitest environments, so we guard carefully.
      const { desktopCapturer, screen: electronScreen } = await import('electron')
      const target = call.args.target === 'window' ? 'window' : 'screen'

      let dataUrl: string | null = null
      let width = 0
      let height = 0

      if (target === 'screen') {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 }
        })
        if (sources.length === 0) {
          return { id: call.id, name: call.name, result: 'Не удалось захватить экран — источников не найдено' }
        }
        const img = sources[0].thumbnail
        dataUrl = img.toDataURL()
        const sz = img.getSize()
        width = sz.width
        height = sz.height
      } else {
        // window — захват окна Verstak через screen source
        const primary = electronScreen.getPrimaryDisplay()
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: primary.size.width, height: primary.size.height }
        })
        // Ищем окно Verstak по имени (title / FileDescription: VERSTAK, Verstak, Electron в dev)
        const win = sources.find(s => /verstak|electron/i.test(s.name)) ?? sources[0]
        if (!win) {
          return { id: call.id, name: call.name, result: 'Не найдено окно для захвата' }
        }
        const img = win.thumbnail
        dataUrl = img.toDataURL()
        const sz = img.getSize()
        width = sz.width
        height = sz.height
      }

      // Attach image to next AI message (same pattern as browser_screenshot)
      if (dataUrl && dataUrl.startsWith('data:image/')) {
        const m = /^data:(image\/[\w+-]+);base64,(.+)$/.exec(dataUrl)
        if (m) {
          ctx.pendingAttachments.push({
            name: `screen-${Date.now()}.png`,
            mimeType: m[1],
            data: m[2],
            size: Math.floor(m[2].length * 0.75)
          })
        }
      }

      emitActivity(ctx, call, 'ok', 'screen_capture', `${target} ${width}x${height}`)
      return {
        id: call.id,
        name: call.name,
        result: { target, width, height, attached: true, timestamp: Date.now() }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', 'screen_capture', msg)
      return { id: call.id, name: call.name, result: '', error: `screen_capture недоступен: ${msg}` }
    }
  }
}

export const screenInfoHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const { screen: electronScreen } = await import('electron')
      const primary = electronScreen.getPrimaryDisplay()
      const displays = electronScreen.getAllDisplays()
      const lines = displays.map((d, i) => {
        const tag = d.id === primary.id ? ' [primary]' : ''
        return `Monitor ${i + 1}: ${d.size.width}x${d.size.height} (scale ${d.scaleFactor}x) pos=(${d.bounds.x},${d.bounds.y})${tag}`
      })
      const result = lines.join('\n')
      emitActivity(ctx, call, 'ok', 'screen_info', `${displays.length} мониторов`)
      return { id: call.id, name: call.name, result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', 'screen_info', msg)
      return { id: call.id, name: call.name, result: '', error: `screen_info недоступен: ${msg}` }
    }
  }
}
