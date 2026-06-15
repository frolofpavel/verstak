/**
 * Migrate Verstak DB project_path from ~/.grok/clients/* to ~/clients/*
 * Usage: node scripts/migrate-project-paths.cjs [--dry-run]
 */
const Database = require('better-sqlite3')
const { homedir } = require('os')
const { join } = require('path')
const { existsSync } = require('fs')

const dryRun = process.argv.includes('--dry-run')
const dbPath = join(process.env.APPDATA || '', 'Verstak', 'storage', 'verstak.db')
const grokClients = join(homedir(), '.grok', 'clients')
const homeClients = join(homedir(), 'clients')

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

const projects = db.prepare('SELECT path, name FROM projects').all()
const mappings = []

for (const p of projects) {
  const norm = p.path.replace(/\//g, '\\')
  if (!norm.toLowerCase().startsWith(grokClients.toLowerCase() + '\\')) continue
  const slug = norm.slice(grokClients.length + 1)
  const target = join(homeClients, slug)
  if (!existsSync(target)) {
    console.warn('SKIP (no target folder):', p.name, '->', target)
    continue
  }
  mappings.push({ from: norm, to: target.replace(/\//g, '\\'), name: p.name })
}

console.log(dryRun ? 'DRY RUN' : 'LIVE', '- mappings:', mappings.length)
for (const m of mappings) console.log(`  ${m.name}: ${m.from} -> ${m.to}`)

const tables = [
  'chats',
  'chat_sessions',
  'tasks',
  'journal',
  'file_undo',
  'feedback',
  'memories',
  'audit_log',
  'run_inputs',
  'plans',
]

function countFor(path) {
  const out = {}
  for (const t of tables) {
    try {
      out[t] = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE project_path = ?`).get(path).c
    } catch {
      out[t] = 0
    }
  }
  return out
}

if (!dryRun && mappings.length > 0) {
  const tx = db.transaction(() => {
    for (const m of mappings) {
      const before = countFor(m.from)
      const totalBefore = Object.values(before).reduce((a, b) => a + b, 0)
      if (totalBefore === 0) {
        console.log('No rows for', m.from)
      }

      for (const t of tables) {
        db.prepare(`UPDATE ${t} SET project_path = ? WHERE project_path = ?`).run(m.to, m.from)
      }

      const promptKeyFrom = `system_prompt_${m.from}`
      const promptKeyTo = `system_prompt_${m.to}`
      const promptRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(promptKeyFrom)
      if (promptRow) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(promptKeyTo, promptRow.value)
        db.prepare('DELETE FROM settings WHERE key = ?').run(promptKeyFrom)
      }

      const existingTarget = db.prepare('SELECT path FROM projects WHERE path = ?').get(m.to)
      if (existingTarget) {
        db.prepare('DELETE FROM projects WHERE path = ?').run(m.from)
      } else {
        db.prepare('UPDATE projects SET path = ? WHERE path = ?').run(m.to, m.from)
      }

      const after = countFor(m.to)
      console.log('Migrated', m.name, before, '->', after)
    }

    const last = db.prepare("SELECT value FROM settings WHERE key = 'last_project_path'").get()
    if (last) {
      for (const m of mappings) {
        if (last.value.includes(m.from) || last.value === m.from) {
          db.prepare("UPDATE settings SET value = ? WHERE key = 'last_project_path'").run(m.to)
        }
      }
    }
  })
  tx()
}

db.close()
console.log('Done.')