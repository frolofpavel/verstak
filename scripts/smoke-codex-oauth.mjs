#!/usr/bin/env node
// Live-смоук direct-OAuth Codex/OpenAI (2.0.4). Запускать на ЗАЛОГИНЕННОМ codex:
//   node scripts/smoke-codex-oauth.mjs
// Проверяет весь wire-формат по ground-truth (Codex 0.144.1) на РЕАЛЬНОМ токене:
//   1) читает ~/.codex/auth.json (или $CODEX_HOME/auth.json),
//   2) достаёт account_id, проверяет срок access_token,
//   3) GET каталог моделей,
//   4) POST минимальный запрос → печатает SSE-события и итог.
// ТОКЕНЫ НЕ ПЕЧАТАЮТСЯ. Ошибки классифицируются (401/403/429/HTML-challenge).
//
// Цель: подтвердить, что формат заголовков/тела/эндпоинта рабочий на этом аккаунте,
// ДО сборки полного провайдера. 403 может значить attestation/Agent-Identity (не наши
// заголовки) — тогда HTTP/SSE fallback этому аккаунту недоступен, нужен WS/app-server.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.144.1'
const WIRE_VERSION = '0.144.1'
const APP_VERSION = '2.0.0'

function authPath() {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  return join(home, 'auth.json')
}

function decodeJwt(jwt) {
  const parts = String(jwt || '').split('.')
  if (parts.length !== 3) return null
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { return null }
}

function accountId(auth) {
  if (auth.tokens?.account_id) return auth.tokens.account_id
  for (const t of [auth.tokens?.id_token, auth.tokens?.access_token]) {
    const p = decodeJwt(t)
    const id = p?.['https://api.openai.com/auth']?.chatgpt_account_id
    if (id) return id
  }
  return null
}

function baseHeaders(access, acc) {
  return {
    'Authorization': `Bearer ${access}`,
    'ChatGPT-Account-ID': acc,
    'originator': 'verstak',
    'User-Agent': `Verstak/${APP_VERSION}`,
    'version': WIRE_VERSION,
  }
}

async function main() {
  console.log('=== Codex direct-OAuth live-смоук ===\n')

  // 1) auth.json
  let auth
  try {
    auth = JSON.parse(readFileSync(authPath(), 'utf8'))
  } catch (e) {
    console.error(`✖ Не прочитать ${authPath()}: ${e.message}`)
    console.error('  Залогинься: npx @openai/codex login (или codex login), потом запусти смоук.')
    process.exit(1)
  }
  console.log(`✓ auth.json прочитан (${authPath()}); auth_mode=${auth.auth_mode ?? '?'}`)

  const access = auth.tokens?.access_token
  if (!access) { console.error('✖ Нет tokens.access_token'); process.exit(1) }
  const acc = accountId(auth)
  if (!acc) { console.error('✖ Не извлёк account_id (ни поле, ни JWT-claim)'); process.exit(1) }
  console.log(`✓ account_id извлечён (длина ${acc.length}, значение скрыто)`)

  const exp = decodeJwt(access)?.exp
  if (exp) {
    const leftMin = Math.round((exp * 1000 - Date.now()) / 60000)
    console.log(`  access_token exp: ${leftMin} мин ${leftMin <= 0 ? '⚠ ИСТЁК — refresh не в этом смоуке, перелогинься' : ''}`)
  }

  // 2) модели
  console.log('\n--- GET каталог моделей ---')
  let model = process.env.SMOKE_MODEL || null
  try {
    const r = await fetch(MODELS_URL, { headers: baseHeaders(access, acc) })
    const text = await r.text()
    console.log(`HTTP ${r.status}`)
    if (r.ok) {
      const j = JSON.parse(text)
      const slugs = (j.models || j.data || []).map(m => m.slug || m.id).filter(Boolean)
      console.log(`✓ модели: ${slugs.slice(0, 12).join(', ') || '(пусто — см. raw)'}`)
      if (!model) model = slugs[0]
    } else {
      console.log(`✖ тело (первые 300): ${text.slice(0, 300)}`)
      classify(r, text)
    }
  } catch (e) { console.error(`✖ models fetch: ${e.message}`) }

  if (!model) { console.error('\n✖ Нет модели для теста запроса. Задай SMOKE_MODEL=<slug> и повтори.'); process.exit(1) }
  console.log(`\n--- POST responses (model=${model}) ---`)

  // 3) минимальный запрос
  const body = {
    model,
    instructions: 'You are a coding assistant.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: OK' }] }],
    tools: [], tool_choice: 'auto', parallel_tool_calls: false,
    reasoning: null, store: false, stream: true, include: [],
  }
  const headers = {
    ...baseHeaders(access, acc),
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'session-id': randomUUID(),
    'thread-id': randomUUID(),
  }
  try {
    const r = await fetch(RESPONSES_URL, { method: 'POST', headers, body: JSON.stringify(body) })
    console.log(`HTTP ${r.status} ${r.headers.get('content-type') || ''}`)
    if (!r.ok) {
      const t = await r.text()
      console.log(`✖ тело (первые 400): ${t.slice(0, 400)}`)
      classify(r, t)
      process.exit(1)
    }
    // читаем SSE, печатаем ТИПЫ событий + собранный текст (не сырой поток)
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = '', text = '', seen = new Set(), usage = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const chunks = buf.split('\n\n'); buf = chunks.pop() ?? ''
      for (const c of chunks) {
        const dl = c.split('\n').find(l => l.startsWith('data:'))
        if (!dl) continue
        const payload = dl.slice(5).trim()
        if (payload === '[DONE]') continue
        let ev; try { ev = JSON.parse(payload) } catch { continue }
        seen.add(ev.type)
        if (ev.type === 'response.output_text.delta' && ev.delta) text += ev.delta
        if (ev.type === 'response.completed') usage = ev.response?.usage ?? null
      }
    }
    console.log(`✓ SSE-события: ${[...seen].join(', ')}`)
    console.log(`✓ собранный текст: "${text.slice(0, 120)}"`)
    if (usage) console.log(`✓ usage: in=${usage.input_tokens} out=${usage.output_tokens} total=${usage.total_tokens}`)
    console.log('\n🎉 УСПЕХ: HTTP/SSE direct-OAuth формат работает на этом аккаунте.')
    console.log('   Скинь мне: список моделей (slugs) + список SSE-событий выше — я доотлажу провайдер по факту.')
  } catch (e) { console.error(`✖ responses fetch: ${e.message}`) }
}

function classify(r, text) {
  const s = r.status
  if (s === 401) console.log('  → 401: токен протух/невалиден. Перелогинься codex.')
  else if (s === 403) console.log('  → 403: возможно Agent-Identity/attestation/rollout/Cloudflare — НЕ косметический заголовок. HTTP/SSE fallback может быть недоступен этому аккаунту (тогда нужен WS/app-server).')
  else if (s === 429) console.log(`  → 429: rate-limit. Retry-After=${r.headers.get('retry-after') || '?'}`)
  else if (/^\s*<(!doctype|html)/i.test(text)) console.log('  → HTML-ответ: Cloudflare/challenge, не JSON API.')
  else console.log(`  → неожиданный ${s}.`)
}

main().catch(e => { console.error('✖ fatal:', e.message); process.exit(1) })
