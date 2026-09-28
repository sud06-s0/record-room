// src/main.tsx
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// No StrictMode: the preview canvas can only be handed to the worker once.
createRoot(document.getElementById('root')!).render(<App />)
