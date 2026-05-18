import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Settings } from './components/Settings'
import { Chat } from './components/Chat'

export function App() {
  const [showSettings, setShowSettings] = useState(false)
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0d0d0d', color: '#e0e0e0', fontFamily: 'sans-serif' }}>
      <Sidebar />
      <main style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <button onClick={() => setShowSettings(true)} style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}>⚙</button>
        <Chat />
      </main>
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  )
}
