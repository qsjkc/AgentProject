import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import { desktopApi, getSessionToken } from './shared/api'
import { getPetVisual } from './shared/pets'

function PetApp() {
  const [petType, setPetType] = useState('cat')
  const clickTimerRef = useRef(null)

  useEffect(() => {
    let mounted = true
    getSessionToken()
      .then((token) => {
        if (!token) {
          return null
        }
        return desktopApi.me()
      })
      .then((user) => {
        if (mounted && user?.preferences?.pet_type) {
          setPetType(user.preferences.pet_type)
        }
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [])

  const petVisual = getPetVisual(petType)

  const handleClick = () => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      window.desktopBridge?.openMainPanel?.()
      return
    }

    clickTimerRef.current = window.setTimeout(() => {
      window.desktopBridge?.toggleQuickChat?.()
      clickTimerRef.current = null
    }, 220)
  }

  return (
    <div className="pet-shell">
      <button type="button" className="pet-button" onClick={handleClick}>
        <div className="pet-button-inner">
          <img className="pet-image" src={petVisual.image} alt={`${petVisual.label} desktop pet`} draggable="false" />
          <div className="pet-label">{petVisual.label}</div>
        </div>
      </button>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<PetApp />)
