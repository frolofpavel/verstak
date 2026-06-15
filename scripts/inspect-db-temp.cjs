const Database = require('better-sqlite3')
const path = process.argv[2]
const db = new Database(path, { readonly: true })
const zapretPaths = [
  'C:\\Users\\RAYNER\\.grok\\clients\\zapret',
  'C:\\Users\\RAYNER\\clients\\zapret',
]

console.log('DB:', path)
console.log('projects:', db.prepare('SELECT COUNT(*) c FROM projects').get().c)
console.log('chat_sessions:', db.prepare('SELECT COUNT(*) c FROM chat_sessions').get().c)
console.log('chats:', db.prepare('SELECT COUNT(*) c FROM chats').get().c)
console.log('memories:', db.prepare('SELECT COUNT(*) c FROM memories').get().c)
console.log('journal:', db.prepare('SELECT COUNT(*) c FROM journal').get().c)
console.log('tasks:', db.prepare('SELECT COUNT(*) c FROM tasks').get().c)

console.log('\nALL PROJECTS:')
for (const p of db.prepare('SELECT path, name FROM projects ORDER BY name').all()) {
  console.log(' -', p.name, '=>', p.path)
}

for (const zp of zapretPaths) {
  console.log('\n===', zp, '===')
  const sess = db.prepare('SELECT id, title, provider_id, model, last_message_at FROM chat_sessions WHERE project_path = ? ORDER BY last_message_at DESC').all(zp)
  console.log('sessions:', sess.length)
  for (const s of sess.slice(0, 10)) {
    const msgs = db.prepare('SELECT COUNT(*) c FROM chats WHERE session_id = ?').get(s.id).c
    console.log(`  #${s.id} "${s.title}" msgs=${msgs} last=${s.last_message_at}`)
  }
  const orphanMsgs = db.prepare('SELECT COUNT(*) c FROM chats WHERE project_path = ? AND (session_id IS NULL OR session_id = 0)').get(zp).c
  console.log('orphan messages (no session):', orphanMsgs)
  console.log('memories:', db.prepare('SELECT COUNT(*) c FROM memories WHERE project_path = ?').get(zp).c)
  console.log('journal:', db.prepare('SELECT COUNT(*) c FROM journal WHERE project_path = ?').get(zp).c)
  console.log('tasks:', db.prepare('SELECT COUNT(*) c FROM tasks WHERE project_path = ?').get(zp).c)
}

const anyZapret = db.prepare("SELECT project_path, COUNT(*) c FROM chat_sessions WHERE project_path LIKE '%zapret%' GROUP BY project_path").all()
console.log('\nzapret-like session paths:', JSON.stringify(anyZapret))

for (const zp of zapretPaths) {
  const msgCount = db.prepare(`
    SELECT COUNT(*) c FROM chats cs
    JOIN chat_sessions s ON cs.session_id = s.id
    WHERE s.project_path = ?
  `).get(zp).c
  console.log('total messages via sessions for', zp, ':', msgCount)
}

console.log('\nsettings with zapret:')
for (const row of db.prepare("SELECT key, substr(value,1,120) v FROM settings WHERE key LIKE '%zapret%' OR value LIKE '%zapret%'").all()) {
  console.log(' ', row.key, '=>', row.v)
}

console.log('\nrecent journal zapret (.grok path):')
for (const row of db.prepare("SELECT id, kind, title, datetime(created_at/1000,'unixepoch') t FROM journal WHERE project_path = ? ORDER BY created_at DESC LIMIT 15").all(zapretPaths[0])) {
  console.log(`  [${row.t}] ${row.kind}: ${row.title}`)
}

db.close()