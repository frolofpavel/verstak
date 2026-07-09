import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { semverGt } from '../lib/semver'
import { ReleaseNotesModal, type ReleaseNote } from './ReleaseNotesModal'

const LAST_WHATS_NEW_KEY = 'last_whats_new_version'

/**
 * После установки обновления: показывает список нововведений из GitHub Release.
 */
export function WhatsNewModal() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState<ReleaseNote[]>([])
  const [version, setVersion] = useState('')
  const [sinceVersion, setSinceVersion] = useState('')
  const [skippedCount, setSkippedCount] = useState(0)

  useEffect(() => {
    void (async () => {
      try {
        if (!window.api?.updater?.getReleaseNotes) return

        const current = await window.api.app.getVersion()
        const last = await window.api.settings.getKey(LAST_WHATS_NEW_KEY)

        if (last && !semverGt(current, last)) return

        let fetched = await window.api.updater.getReleaseNotes({
          sinceVersion: last || current,
          upToVersion: current,
        })

        if (fetched.length === 0) {
          const currentNote = await window.api.updater.getReleaseNotes({ version: current })
          if (currentNote.length > 0) fetched = currentNote
        }

        if (fetched.length === 0) return

        setNotes(fetched)
        setVersion(current)
        setOpen(true)
        setSkippedCount(fetched.length)
        setSinceVersion(last || current)
      } catch (err) {
        console.warn('[whats-new] skipped:', err)
      }
    })()
  }, [])

  const handleClose = () => {
    setOpen(false)
    void (async () => {
      const current = version || await window.api.app.getVersion()
      await window.api.settings.setKey(LAST_WHATS_NEW_KEY, current)
    })()
  }

  const multi = skippedCount > 1
  const title = multi ? t.updates.whatsNewTitleMulti : t.updates.whatsNewTitle
  const subtitle = multi
    ? t.updates.whatsNewSubtitleMulti
        .replace('{count}', String(skippedCount))
        .replace('{from}', sinceVersion)
        .replace('{to}', version)
    : t.updates.whatsNewSubtitle.replace('{version}', version)

  return (
    <ReleaseNotesModal
      open={open}
      onClose={handleClose}
      notes={notes}
      title={title}
      subtitle={subtitle}
      emptyText={t.settings.releaseNotesEmpty}
      showAllVersionHeaders={multi}
    />
  )
}
