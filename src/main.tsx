import { createRoot } from 'react-dom/client'
import { App } from './App'
import { bootstrapAppearance } from './hooks/useAppearance'
import { bootstrapTheme } from './hooks/useTheme'
import './styles/theme.css'
import './styles/layout.css'
import './styles/shell-atelier.css'
import './styles/atelier-global.css'
import './styles/title-bar.css'
import './styles/markdown.css'

document.documentElement.classList.add('gg-atelier')
void bootstrapAppearance()
void bootstrapTheme()
createRoot(document.getElementById('root')!).render(<App />)
