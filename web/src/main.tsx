import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MOTION_MODE } from '#web-shared/motion.ts'
import { App } from '#web-app/app.tsx'
import './index.css'

document.documentElement.dataset.motion = MOTION_MODE

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
