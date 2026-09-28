// src/main.tsx
import { createRoot } from 'react-dom/client'
import App from './App'
import PhonePage from './components/PhonePage'
import './index.css'

// Same link, two apps: `?phone=<room>` opens the mobile camera page (from the QR code),
// anything else opens the desktop recorder.
const phoneRoom = new URLSearchParams(location.search).get('phone')

// No StrictMode: the preview canvas can only be handed to the worker once.
createRoot(document.getElementById('root')!).render(phoneRoom ? <PhonePage room={phoneRoom} /> : <App />)
