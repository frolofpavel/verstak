// Живая проверка обновления ПОСЛЕ публикации релиза.
//
// Отвечает на вопрос, который не закрывает ни один offline-тест: увидит ли и сможет ли
// скачать новую версию человек, у которого стоит предыдущая. Проверяется ТЕМ ЖЕ кодом,
// которым это делает установленное приложение (electron/update-remote.ts), по тем же
// публичным адресам — без установки, без записи в реестр, без ярлыков.
//
// Запуск (после npm run release:publish):
//   VERSTAK_LIVE_RELEASE_CHECK=1 npx vitest run tests/live/update-release.live.test.ts
// Версии можно задать явно:
//   VERSTAK_RELEASE_FROM=2.0.12 VERSTAK_RELEASE_TO=2.2.0
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fetchLatestPublishedReleaseVersion,
  fetchReleaseArtifactMeta,
  releaseArtifactsReady,
  resolveInstallableUpdate,
  semverGt,
  UPDATE_OWNER,
  UPDATE_REPO,
} from '../../electron/update-remote'

const LIVE = process.env.VERSTAK_LIVE_RELEASE_CHECK === '1'
const TO = process.env.VERSTAK_RELEASE_TO
  ?? (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version
const FROM = process.env.VERSTAK_RELEASE_FROM ?? '2.0.12'

describe.skipIf(!LIVE)(`обновление ${FROM} → ${TO} на живом релизе`, () => {
  it('последним опубликованным релизом числится именно эта версия', async () => {
    expect(await fetchLatestPublishedReleaseVersion()).toBe(TO)
  }, 60_000)

  it('артефакты релиза на месте — Setup и latest.yml читаются', async () => {
    expect(await releaseArtifactsReady(TO)).toBe(true)
  }, 60_000)

  it('updater считает версию УСТАНАВЛИВАЕМОЙ, а не «ожидает релиз»', async () => {
    // pendingVersion — это состояние «в main версия есть, установщика нет»: кнопка
    // загрузки в таком виде отказывает. Ради этого сценария проверка и написана.
    const resolved = await resolveInstallableUpdate(FROM, TO)
    expect(resolved.installable).toBe(TO)
    expect(resolved.pendingVersion).toBeFalsy()
    expect(semverGt(TO, FROM)).toBe(true)
  }, 60_000)

  it('Setup.exe реально качается по адресу апдейтера и совпадает с latest.yml', async () => {
    const meta = await fetchReleaseArtifactMeta(TO)
    expect(meta, 'метаданные артефакта не прочитались').toBeTruthy()

    const url = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v${TO}/${meta!.fileName}`
    const res = await fetch(url)
    expect(res.ok, `HTTP ${res.status} на ${url}`).toBe(true)

    const body = Buffer.from(await res.arrayBuffer())
    // Размер и sha512 — ровно те проверки, по которым апдейтер решает, что скачал
    // целый файл, а не обрыв или страницу ошибки.
    expect(body.length).toBe(meta!.size)
    expect(createHash('sha512').update(body).digest('base64')).toBe(meta!.sha512)
    // Скачали исполняемый файл Windows, а не HTML-заглушку.
    expect(body.subarray(0, 2).toString('latin1')).toBe('MZ')
  }, 600_000)
})
