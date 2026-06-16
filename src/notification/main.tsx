import { createRoot } from 'react-dom/client'
import { NotificationApp } from './NotificationApp'
import '../styles/theme.css'
import './notification.css'

createRoot(document.getElementById('root')!).render(<NotificationApp />)