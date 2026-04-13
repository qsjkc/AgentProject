import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import { desktopApi, getLanguage, getSessionToken } from './shared/api'
import { getMessagePool, normalizeLanguage, t } from './shared/i18n'
import { getPetVisual } from './shared/pets'

const DEFAULT_PREFERENCES = {
  quick_chat_enabled: true,
  bubble_frequency: 120,
}

const DRAG_THRESHOLD = 8

function pickRandom(items) {
  if (!items.length) {
    return ''
  }

  return items[Math.floor(Math.random() * items.length)]
}

function PetApp() {
  const [petType, setPetType] = useState('cat')
  const [language, setLanguage] = useState('zh-CN')
  const [petMood, setPetMood] = useState('idle')
  const [bubbleText, setBubbleText] = useState('')
  const [hasSession, setHasSession] = useState(false)
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES)

  const clickTimerRef = useRef(null)
  const bubbleTimerRef = useRef(null)
  const moodTimerRef = useRef(null)
  const idleBubbleTimerRef = useRef(null)
  const rafRef = useRef(null)
  const suppressClickRef = useRef(false)
  const previousSessionRef = useRef(null)
  const petPositionRef = useRef({ x: 90, y: 90 })
  const pendingPositionRef = useRef(null)
  const dragRef = useRef({
    pointerId: null,
    startScreenX: 0,
    startScreenY: 0,
    startWindowX: 0,
    startWindowY: 0,
    moved: false,
  })

  const clearMoodTimer = () => {
    if (moodTimerRef.current) {
      window.clearTimeout(moodTimerRef.current)
      moodTimerRef.current = null
    }
  }

  const clearBubbleTimer = () => {
    if (bubbleTimerRef.current) {
      window.clearTimeout(bubbleTimerRef.current)
      bubbleTimerRef.current = null
    }
  }

  const resetMood = () => {
    setPetMood(hasSession ? 'idle' : 'sad')
  }

  const setTemporaryMood = (nextMood, duration = 1400) => {
    clearMoodTimer()
    setPetMood(nextMood)
    moodTimerRef.current = window.setTimeout(() => {
      resetMood()
    }, duration)
  }

  const showBubble = (text, options = {}) => {
    if (!text) {
      return
    }

    const { mood = hasSession ? 'happy' : 'sad', duration = 2600 } = options

    clearBubbleTimer()
    setBubbleText(text)
    setTemporaryMood(mood, Math.min(duration, 2200))
    bubbleTimerRef.current = window.setTimeout(() => {
      setBubbleText('')
    }, duration)
  }

  useEffect(() => {
    let mounted = true

    const syncState = async () => {
      try {
        const [savedLanguage, token, bounds] = await Promise.all([
          getLanguage(),
          getSessionToken(),
          window.desktopBridge?.getPetBounds?.(),
        ])

        if (!mounted) {
          return
        }

        setLanguage(normalizeLanguage(savedLanguage))
        setHasSession(Boolean(token))
        if (bounds?.x !== undefined && bounds?.y !== undefined) {
          petPositionRef.current = bounds
        }

        if (!token) {
          setPreferences(DEFAULT_PREFERENCES)
          setPetMood('sad')
          return
        }

        const user = await desktopApi.me()
        if (!mounted) {
          return
        }

        if (user?.preferences?.pet_type) {
          setPetType(user.preferences.pet_type)
        }

        setPreferences({
          quick_chat_enabled: user?.preferences?.quick_chat_enabled ?? DEFAULT_PREFERENCES.quick_chat_enabled,
          bubble_frequency: user?.preferences?.bubble_frequency ?? DEFAULT_PREFERENCES.bubble_frequency,
        })
        setPetMood('idle')
      } catch {
        if (mounted) {
          setHasSession(false)
          setPreferences(DEFAULT_PREFERENCES)
          setPetMood('sad')
        }
      }
    }

    void syncState()
    window.addEventListener('focus', syncState)

    return () => {
      mounted = false
      window.removeEventListener('focus', syncState)
    }
  }, [])

  useEffect(() => {
    if (previousSessionRef.current === null) {
      previousSessionRef.current = hasSession
      const introTimer = window.setTimeout(() => {
        showBubble(t(language, hasSession ? 'interactionHint' : 'signInHint'), {
          mood: hasSession ? 'happy' : 'sad',
          duration: 3200,
        })
      }, 700)

      return () => {
        window.clearTimeout(introTimer)
      }
    }

    if (previousSessionRef.current !== hasSession) {
      previousSessionRef.current = hasSession
      showBubble(t(language, hasSession ? 'interactionHint' : 'signInHint'), {
        mood: hasSession ? 'happy' : 'sad',
        duration: 3200,
      })
    }
  }, [hasSession, language])

  useEffect(() => {
    if (idleBubbleTimerRef.current) {
      window.clearInterval(idleBubbleTimerRef.current)
      idleBubbleTimerRef.current = null
    }

    const frequencySeconds = Math.max(30, Number(preferences.bubble_frequency) || DEFAULT_PREFERENCES.bubble_frequency)
    idleBubbleTimerRef.current = window.setInterval(() => {
      if (dragRef.current.pointerId !== null || clickTimerRef.current || bubbleText) {
        return
      }

      const poolKey = hasSession ? (Math.random() > 0.65 ? 'petHappyMessages' : 'petIdleMessages') : 'petSadMessages'
      const mood = poolKey === 'petHappyMessages' ? 'happy' : hasSession ? 'idle' : 'sad'
      showBubble(pickRandom(getMessagePool(language, poolKey)), { mood })
    }, frequencySeconds * 1000)

    return () => {
      if (idleBubbleTimerRef.current) {
        window.clearInterval(idleBubbleTimerRef.current)
        idleBubbleTimerRef.current = null
      }
    }
  }, [bubbleText, hasSession, language, preferences.bubble_frequency])

  useEffect(
    () => () => {
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current)
      }
      clearBubbleTimer()
      clearMoodTimer()
      if (idleBubbleTimerRef.current) {
        window.clearInterval(idleBubbleTimerRef.current)
      }
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current)
      }
    },
    [],
  )

  const petVisual = getPetVisual(petType, petMood)
  const petLabel = t(language, petVisual.labelKey)

  const queuePetPosition = (nextPosition) => {
    pendingPositionRef.current = nextPosition

    if (rafRef.current) {
      return
    }

    rafRef.current = window.requestAnimationFrame(() => {
      const latestPosition = pendingPositionRef.current
      rafRef.current = null
      if (!latestPosition) {
        return
      }

      window.desktopBridge
        ?.setPetPosition?.(latestPosition)
        .then((bounds) => {
          if (bounds?.x !== undefined && bounds?.y !== undefined) {
            petPositionRef.current = bounds
          } else {
            petPositionRef.current = { ...petPositionRef.current, ...latestPosition }
          }
        })
        .catch(() => undefined)
    })
  }

  const handlePointerDown = (event) => {
    if (event.button !== 0) {
      return
    }

    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWindowX: petPositionRef.current.x ?? 90,
      startWindowY: petPositionRef.current.y ?? 90,
      moved: false,
    }
    clearMoodTimer()
    setPetMood('excited')
  }

  const handlePointerMove = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) {
      return
    }

    const deltaX = event.screenX - dragRef.current.startScreenX
    const deltaY = event.screenY - dragRef.current.startScreenY
    if (!dragRef.current.moved && (Math.abs(deltaX) >= 2 || Math.abs(deltaY) >= 2)) {
      dragRef.current.moved = true
    }

    if (!dragRef.current.moved) {
      return
    }

    queuePetPosition({
      x: dragRef.current.startWindowX + deltaX,
      y: dragRef.current.startWindowY + deltaY,
    })
  }

  const finishPointerInteraction = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) {
      return
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const didMove = dragRef.current.moved
    dragRef.current = {
      pointerId: null,
      startScreenX: 0,
      startScreenY: 0,
      startWindowX: 0,
      startWindowY: 0,
      moved: false,
    }

    if (didMove) {
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 240)
      showBubble(t(language, 'dragSaved'), { mood: 'happy', duration: 1400 })
      return
    }

    resetMood()
  }

  const handleSingleClick = async () => {
    if (!hasSession) {
      showBubble(t(language, 'signInHint'), { mood: 'sad', duration: 2800 })
      return
    }

    if (!preferences.quick_chat_enabled) {
      showBubble(t(language, 'quickChatDisabledHint'), { mood: 'happy', duration: 2200 })
      return
    }

    const visible = await window.desktopBridge?.toggleQuickChat?.()
    showBubble(t(language, visible ? 'quickChatOpened' : 'quickChatClosed'), {
      mood: visible ? 'excited' : 'happy',
      duration: 1800,
    })
  }

  const handleClick = () => {
    if (suppressClickRef.current) {
      return
    }

    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      window.desktopBridge?.openMainPanel?.()
      showBubble(t(language, 'mainPanelOpened'), { mood: 'excited', duration: 2000 })
      return
    }

    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      void handleSingleClick()
    }, 220)
  }

  const handleMouseEnter = () => {
    if (dragRef.current.pointerId !== null || bubbleText) {
      return
    }
    setPetMood(hasSession ? 'happy' : 'sad')
  }

  const handleMouseLeave = () => {
    if (dragRef.current.pointerId !== null || bubbleText) {
      return
    }
    resetMood()
  }

  return (
    <div className="pet-shell">
      <div className={`pet-scene mood-${petMood}`}>
        {bubbleText && <div className="pet-bubble">{bubbleText}</div>}
        <button
          type="button"
          className="pet-button"
          onClick={handleClick}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerInteraction}
          onPointerCancel={finishPointerInteraction}
          aria-label={t(language, 'desktopPetAlt', { pet: petLabel })}
        >
          <div className="pet-button-inner">
            <img className="pet-image" src={petVisual.image} alt={t(language, 'desktopPetAlt', { pet: petLabel })} draggable="false" />
          </div>
        </button>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<PetApp />)
