import { describe, it, expect } from 'vitest'
import { shq, remoteDirname, buildReadCmd, buildWriteCmd, buildListCmd, parseListOutput } from '../../electron/projects/ssh-fs'

describe('ssh-fs', () => {
  it('shq экранирует одинарные кавычки', () => {
    expect(shq('a/b.txt')).toBe("'a/b.txt'")
    expect(shq("it's")).toBe("'it'\\''s'")
  })

  it('remoteDirname', () => {
    expect(remoteDirname('/var/www/site/index.html')).toBe('/var/www/site')
    expect(remoteDirname('/file')).toBe('/')
    expect(remoteDirname('file')).toBe('.')
  })

  it('buildReadCmd: cat с кавычкой пути', () => {
    expect(buildReadCmd('/var/www/index.html')).toBe("cat -- '/var/www/index.html'")
  })

  it('buildWriteCmd: mkdir родителя + cat > файл', () => {
    expect(buildWriteCmd('/var/www/site/a.css')).toBe("mkdir -p '/var/www/site' && cat > '/var/www/site/a.css'")
  })


  it('buildListCmd: ls с экранированным путём', () => {
    expect(buildListCmd('/var/www')).toBe("ls -1Ap -- '/var/www'")
  })

  it('parseListOutput: каталоги (с /) vs файлы, мусор отброшен', () => {
    const out = 'src/\nindex.html\nstyle.css\n./\n'
    expect(parseListOutput(out)).toEqual([
      { name: 'src', isDirectory: true },
      { name: 'index.html', isDirectory: false },
      { name: 'style.css', isDirectory: false },
    ])
  })
})
