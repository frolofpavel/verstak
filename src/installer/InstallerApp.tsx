import { InstallerTitleBar } from './InstallerTitleBar'
import { SetupWizard } from './SetupWizard'

export function InstallerApp() {
  return (
    <div className="gg-installer-shell">
      <InstallerTitleBar />
      <SetupWizard />
    </div>
  )
}