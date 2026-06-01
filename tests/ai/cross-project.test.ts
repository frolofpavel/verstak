import { describe, it, expect } from 'vitest'
import { detectCrossProjectPaths } from '../../electron/ai/context-pack'

describe('detectCrossProjectPaths', () => {
  const proj = 'C:/Users/testuser/verstak'

  it('flags абсолютный путь вне проекта (Windows)', () => {
    const r = detectCrossProjectPaths('сделай аудит C:\\Users\\testuser\\other-project', proj)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatch(/other-project/)
  })

  it('игнорирует пути внутри активного проекта', () => {
    const r = detectCrossProjectPaths('правка C:\\Users\\testuser\\verstak\\src\\App.tsx', proj)
    expect(r).toEqual([])
  })

  it('case-insensitive — c:/users/...', () => {
    const r = detectCrossProjectPaths('файл c:/users/testuser/other-project/main.py', proj)
    expect(r).toHaveLength(1)
  })

  it('ловит POSIX пути', () => {
    const r = detectCrossProjectPaths('загляни в /Users/me/other-repo/src', '/Users/me/my-proj')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatch(/other-repo/)
  })

  it('игнорирует пути внутри кодоблоков', () => {
    const text = '```\nC:\\Users\\testuser\\other\\file.ts\n```'
    expect(detectCrossProjectPaths(text, proj)).toEqual([])
  })

  it('дедупликация одинаковых путей', () => {
    const r = detectCrossProjectPaths(
      'C:\\foo\\bar и опять C:\\foo\\bar',
      proj
    )
    expect(r).toHaveLength(1)
  })

  it('cap 5 путей чтобы не раздувать промпт', () => {
    const text = 'A C:\\a B C:\\b C C:\\c D C:\\d E C:\\e F C:\\f G C:\\g'
    const r = detectCrossProjectPaths(text, proj)
    expect(r.length).toBeLessThanOrEqual(5)
  })

  it('пустой ввод — пустой результат', () => {
    expect(detectCrossProjectPaths('', proj)).toEqual([])
    expect(detectCrossProjectPaths('просто текст без путей', proj)).toEqual([])
  })
})
