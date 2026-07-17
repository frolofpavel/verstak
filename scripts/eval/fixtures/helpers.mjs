import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { cleanGitEnvironment } from '../contracts.mjs'

export function materializeFixture(root, fixture) {
  writePackage(root, fixture.scripts)
  writeFiles(root, fixture.files)
  initGitBaseline(root)
  writeFiles(root, fixture.afterBaselineFiles ?? {})
}

export function snapshot(root) {
  const files = new Map()
  walk(root, root, files)
  return files
}

export function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()])
  return [...names].filter(name => before.get(name) !== after.get(name)).sort()
}

export function diffLines(before, after, files) {
  let count = 0
  for (const file of files) {
    const previous = (before.get(file) ?? '').split(/\r?\n/)
    const current = (after.get(file) ?? '').split(/\r?\n/)
    const max = Math.max(previous.length, current.length)
    for (let i = 0; i < max; i++) {
      if (previous[i] !== current[i]) count++
    }
  }
  return count
}

export function runVerify(root, commands) {
  return commands.map(command => {
    const result = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 6 * 1024 * 1024,
    })
    return {
      command,
      exitCode: result.status ?? 1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(0, 4000),
    }
  })
}

function writePackage(root, scripts) {
  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: `verstak-eval-${basename(root).replace(/[^a-z0-9-]/gi, '-')}`,
        private: true,
        type: 'module',
        scripts,
      },
      null,
      2,
    ) + '\n',
  )
}

function writeFiles(root, files) {
  for (const [file, content] of Object.entries(files)) writeFile(root, file, content)
}

function writeFile(root, file, content) {
  const target = join(root, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function initGitBaseline(root) {
  runGit(root, ['init'])
  runGit(root, ['config', 'user.email', 'eval@example.local'])
  runGit(root, ['config', 'user.name', 'Verstak Eval'])
  runGit(root, ['add', '.'])
  runGit(root, ['commit', '-m', 'baseline'])
}

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: cleanGitEnvironment(),
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
}

function walk(root, dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.verstak') continue
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) walk(root, absolute, files)
    else if (entry.isFile()) files.set(relative(root, absolute).replace(/\\/g, '/'), readFileSync(absolute, 'utf8'))
  }
}
