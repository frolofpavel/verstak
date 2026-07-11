import { createServer, type ServerResponse } from 'node:http'
import { parseEnvelope } from '../shared/protocol'
import { verifyBearer, type RelayIdentity, type RelayRole } from './auth'
import { createRelayRouter } from './router'

export function createRelayServer(options: { token: string; port?: number }) {
  const router = createRelayRouter()
  const streams = new WeakMap<ServerResponse, () => void>()
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.VERSTAK_MOBILE_ALLOWED_ORIGIN || '*')
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
    if (req.url === '/health') { res.writeHead(200).end('ok'); return }
    if (!verifyBearer(req.headers.authorization, options.token)) { res.writeHead(401).end('unauthorized'); return }
    const url = new URL(req.url ?? '/', 'http://relay.local')
    const accountId = url.searchParams.get('accountId') ?? ''
    const deviceId = url.searchParams.get('deviceId') ?? ''
    const role = url.searchParams.get('role') as RelayRole
    if (!accountId || !deviceId || !['desktop', 'mobile'].includes(role)) { res.writeHead(400).end('invalid identity'); return }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.flushHeaders()
      const identity: RelayIdentity = { accountId, deviceId, role }
      const unregister = router.registerConnection(identity, envelope => res.write(`data:${JSON.stringify(envelope)}\n\n`))
      streams.set(res, unregister)
      req.on('close', unregister)
      return
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        try {
          const envelope = parseEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          if (envelope.accountId !== accountId || envelope.deviceId !== deviceId) throw new Error('identity mismatch')
          const result = router.route(envelope)
          res.writeHead(result.delivered ? 202 : 409, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
        } catch (error) {
          res.writeHead(400).end(error instanceof Error ? error.message : 'invalid message')
        }
      })
      return
    }
    res.writeHead(404).end('not found')
  })
  return { router, server, listen: () => new Promise<void>(resolve => server.listen(options.port ?? 8787, resolve)), close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

if (process.argv[1] && /server\.(?:ts|mjs|js)$/.test(process.argv[1])) {
  const token = process.env.VERSTAK_MOBILE_RELAY_TOKEN
  if (!token) throw new Error('VERSTAK_MOBILE_RELAY_TOKEN is required')
  void createRelayServer({ token, port: Number(process.env.PORT ?? 8787) }).listen()
}
