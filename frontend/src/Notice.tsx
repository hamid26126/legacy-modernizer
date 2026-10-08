import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoticeData } from './useNotice'

const AUTO_DISMISS_MS = 5000
const FADE_MS = 350

const KIND_ICON: Record<NoticeData['kind'], string> = {
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
  success: '✓',
}

/**
 * The app's one and only banner/note renderer.
 *
 * - The close button really dismisses it (clears notice state, nothing else —
 *   action buttons, stages and inputs live outside this component).
 * - Error/warning/info notices fade out and dismiss themselves after 5s.
 *   The countdown pauses while the pointer is over the notice and restarts
 *   (full 5s) when it leaves.
 * - `autoDismiss: false` (final result summary) keeps it until closed.
 */
export function Notice({ notice, onDismiss }: { notice: NoticeData; onDismiss: () => void }) {
  const [fading, setFading] = useState(false)
  const hoveringRef = useRef(false)
  const fadingRef = useRef(false)
  const dismissTimerRef = useRef<number | null>(null)
  const fadeTimerRef = useRef<number | null>(null)
  const onDismissRef = useRef(onDismiss)

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
  }, [])

  const startTimer = useCallback(() => {
    if (!notice.autoDismiss || fadingRef.current || hoveringRef.current) return
    clearDismissTimer()
    dismissTimerRef.current = window.setTimeout(() => {
      fadingRef.current = true
      setFading(true)
      fadeTimerRef.current = window.setTimeout(() => onDismissRef.current(), FADE_MS)
    }, AUTO_DISMISS_MS)
  }, [notice.autoDismiss, clearDismissTimer])

  // (Re)start the countdown whenever a new notice arrives; tear both timers
  // down on unmount so a dismissed notice can never fire a stale callback.
  // The parent keys this component by notice.id, so every notice is a fresh
  // mount — fading/hover state starts clean without resetting it here.
  useEffect(() => {
    startTimer()
    return () => {
      clearDismissTimer()
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current)
        fadeTimerRef.current = null
      }
    }
  }, [notice.id, startTimer, clearDismissTimer])

  const handleMouseEnter = () => {
    // Pause — the countdown must not run while the user is reading it.
    hoveringRef.current = true
    clearDismissTimer()
  }

  const handleMouseLeave = () => {
    // Restart the full 5s countdown once the pointer leaves.
    hoveringRef.current = false
    startTimer()
  }

  return (
    <div
      className={`banner banner--${notice.kind}${fading ? ' is-fading' : ''}`}
      role="alert"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span className="banner-icon">{notice.icon ?? KIND_ICON[notice.kind]}</span>
      <span className="banner-message">{notice.message}</span>
      <button
        type="button"
        className="banner-close"
        aria-label="Dismiss notice"
        onClick={() => onDismissRef.current()}
      >
        ✕
      </button>
    </div>
  )
}
