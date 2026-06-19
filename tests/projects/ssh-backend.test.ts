import { describe, it, expect, vi } from 'vitest'
import { parseSshProjectPath, resolveRemotePath, createSshBackend, type SshExec } from '../../electron/projects/ssh-backend'

describe('parseSshProjectPath', () => {
  it('ssh://user@host/path', () => {
    expect(parseSshProjectPath('ssh://root@agi-iri.ru/var/www/agi-iri.ru')).toEqual({
      user: 'root', host: 'agi-iri.ru', remoteRoot: '/var/www/agi-iri.ru',
    })
  })
  it('ssh://host/path без user', () => {
    expect(parseSshProjectPath('ssh://srv/srv/site')).toEqual({ user: null, host: 'srv', remoteRoot: '/srv/site' })
  })
  it('не ssh → null', () => {
    expect(parseSshProjectPath('C:\\proj')).toBeNull()
  })
})

describe('resolveRemotePath (escape-guard)', () => {
  const root = '/var/www/site'
  it('обычные пути под корнем', () => {
    expect(resolveRemotePath(root, 'index.html')).toBe('/var/www/site/index.html')
    expect(resolveRemotePath(root, './src/a.css')).toBe('/var/www/site/src/a.css')
    expect(resolveRemotePath(root, 'a/b/../c.txt')).toBe('/var/www/site/a/c.txt')
  })
  it('escape за корень → null (БЕЗОПАСНОСТЬ)', () => {
    expect(resolveRemotePath(root, '../../../etc/passwd')).toBeNull()
    expect(resolveRemotePath(root, '../other')).toBeNull()
    expect(resolveRemotePath(root, 'a/../../..')).toBeNull()
  })
  it('абсолютный путь в аргументе трактуется как относительный (не вырывается)', () => {
    expect(resolveRemotePath(root, '/etc/passwd')).toBe('/var/www/site/etc/passwd')
  })
})

describe('createSshBackend (mock exec)', () => {
  const ok = (stdout: string): Awaited<ReturnType<SshExec>> => ({ stdout, stderr: '', exitCode: 0 })

  it('readFile: cat + abs-путь, возвращает содержимое', async () => {
    const exec = vi.fn<SshExec>(async () => ok('<html></html>'))
    const be = createSshBackend('/var/www/site', exec)
    expect(await be.readFile('index.html')).toBe('<html></html>')
    expect(exec.mock.calls[0][0]).toBe("cat -- '/var/www/site/index.html'")
  })

  it('writeFile: контент в stdin, mkdir родителя', async () => {
    const exec = vi.fn<SshExec>(async () => ok(''))
    const be = createSshBackend('/var/www/site', exec)
    await be.writeFile('css/a.css', 'body{}')
    expect(exec.mock.calls[0][0]).toBe("mkdir -p '/var/www/site/css' && cat > '/var/www/site/css/a.css'")
    expect(exec.mock.calls[0][1]).toBe('body{}')
  })

  it('listDir: каталоги с / → имена + isDirectory', async () => {
    const exec = vi.fn<SshExec>(async () => ok('src/\nindex.html\n'))
    const be = createSshBackend('/var/www/site', exec)
    expect(await be.listDir('.')).toEqual(['src/', 'index.html'])
  })

  it('runCommand: cd в корень + команда', async () => {
    const exec = vi.fn<SshExec>(async () => ok('done'))
    const be = createSshBackend('/var/www/site', exec)
    await be.runCommand('ls -la')
    expect(exec.mock.calls[0][0]).toBe("cd '/var/www/site' && ls -la")
  })

  it('escape-путь → бросает, exec не зовётся', async () => {
    const exec = vi.fn<SshExec>(async () => ok(''))
    const be = createSshBackend('/var/www/site', exec)
    await expect(be.readFile('../../../etc/passwd')).rejects.toThrow(/вне корня/)
    expect(exec).not.toHaveBeenCalled()
  })

  it('ssh exit != 0 → ошибка с stderr', async () => {
    const exec = vi.fn<SshExec>(async () => ({ stdout: '', stderr: 'No such file', exitCode: 1 }))
    const be = createSshBackend('/var/www/site', exec)
    await expect(be.readFile('nope.txt')).rejects.toThrow(/No such file/)
  })
})
