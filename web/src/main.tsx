import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './board/app.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
