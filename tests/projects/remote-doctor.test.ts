import { describe, expect, it } from 'vitest'
import { buildRemoteDoctorCommand, parseRemoteDoctorOutput } from '../../electron/projects/remote-doctor'

const target = { user: 'root', host: 'srv', remoteRoot: '/srv/site' }

function check(result: ReturnType<typeof parseRemoteDoctorOutput>, id: string) {
  const found = result.checks.find(item => item.id === id)
  if (!found) throw new Error(`missing check ${id}`)
  return found
}

describe('remote doctor', () => {
  it('builds a diagnostics command without package installation', () => {
    const command = buildRemoteDoctorCommand()

    expect(command).toContain('__VERSTAK_REMOTE_DOCTOR_V1__')
    expect(command).toContain('command -v "$c"')
    expect(command).toContain('.verstak-remote-doctor-$$')
    expect(command).not.toContain('npm install')
    expect(command).not.toContain('apt ')
  })

  it('returns pass when ssh shell and toolchain are ready', () => {
    const result = parseRemoteDoctorOutput([
      '__VERSTAK_REMOTE_DOCTOR_V1__',
      'pwd=/srv/site',
      'uname=Linux',
      'root=ok',
      'read=ok',
      'write=ok',
      'cmd_git=ok|git version 2.44.0',
      'cmd_node=ok|v22.0.0',
      'cmd_npm=ok|10.0.0',
      'cmd_npx=ok|10.0.0',
      'cmd_rg=ok|ripgrep 14.1.0',
      'cmd_tsc=ok|Version 5.9.0',
      'file_package=ok',
      'file_tsconfig=ok'
    ].join('\n'), '', 0, target)

    expect(result.status).toBe('pass')
    expect(result.ok).toBe(true)
    expect(check(result, 'unix_shell').status).toBe('pass')
    expect(check(result, 'write_access').status).toBe('pass')
    expect(check(result, 'rg').detail).toContain('ripgrep')
  })

  it('returns warn for missing optional tools without blocking work', () => {
    const result = parseRemoteDoctorOutput([
      '__VERSTAK_REMOTE_DOCTOR_V1__',
      'pwd=/srv/site',
      'uname=Darwin',
      'root=ok',
      'read=ok',
      'write=ok',
      'cmd_git=ok|git version 2.40.0',
      'cmd_node=missing',
      'cmd_npm=missing',
      'cmd_npx=missing',
      'cmd_rg=missing',
      'cmd_tsc=missing',
      'file_package=missing',
      'file_tsconfig=missing'
    ].join('\n'), '', 0, target)

    expect(result.status).toBe('warn')
    expect(result.ok).toBe(true)
    expect(check(result, 'node').status).toBe('warn')
    expect(check(result, 'write_access').status).toBe('pass')
  })

  it('returns fail when ssh command did not reach the probe', () => {
    const result = parseRemoteDoctorOutput('', 'Permission denied', 255, target)

    expect(result.status).toBe('fail')
    expect(result.ok).toBe(false)
    expect(check(result, 'connection').status).toBe('fail')
    expect(check(result, 'project_root').status).toBe('fail')
  })

  it('returns fail for Windows-like remote shell', () => {
    const result = parseRemoteDoctorOutput([
      '__VERSTAK_REMOTE_DOCTOR_V1__',
      'pwd=/srv/site',
      'uname=MINGW64_NT',
      'root=ok',
      'read=ok',
      'write=ok',
      'cmd_git=ok|git version',
      'cmd_node=ok|v22',
      'cmd_npm=ok|10',
      'cmd_npx=ok|10',
      'cmd_rg=ok|ripgrep',
      'cmd_tsc=ok|Version 5',
      'file_package=ok',
      'file_tsconfig=ok'
    ].join('\n'), '', 0, target)

    expect(result.status).toBe('fail')
    expect(check(result, 'unix_shell').detail).toContain('Windows SSH shell')
  })
})
