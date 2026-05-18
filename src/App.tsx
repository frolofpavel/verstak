import { Sidebar } from './components/Sidebar'

export function App() {
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0d0d0d', color: '#e0e0e0', fontFamily: 'sans-serif' }}>
      <Sidebar />
      <main style={{ flex: 1, padding: 20 }}>
        <h2>Чат с Gemini</h2>
        <p style={{ color: '#888' }}>Откроется в следующей задаче</p>
      </main>
    </div>
  )
}
