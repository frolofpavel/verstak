import { createRoot } from 'react-dom/client'
import { InstallerApp } from './InstallerApp'
import '../styles/theme.css'
import '../styles/title-bar.css'
import './installer.css'

document.documentElement.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<InstallerApp />)