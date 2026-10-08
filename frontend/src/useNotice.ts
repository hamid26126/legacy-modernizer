import { useCallback, useRef, useState } from 'react'

/**
 * Shared notice state for every banner/note in the app.
 *
 * One slot, one shape: any message shown through `showNotice` renders as a
 * dismissible Notice. Each call gets a fresh monotonically increasing id, so
 * a new message always shows again even if the previous one was dismissed
 * (dismissing only empties the slot — it never touches stage, actions or any
 * other app state).
 */

export type NoticeKind = 'error' | 'warning' | 'info' | 'success'

export interface NoticeData {
  /** Monotonic per-notice id — also used as the React key. */
  id: number
  kind: NoticeKind
  message: string
  /** Optional glyph override (defaults to the kind's icon). */
  icon?: string
  /**
   * Error/warning/info notices auto-dismiss after 5 seconds. The final result
   * summary passes false so it stays until the user closes it.
   */
  autoDismiss: boolean
}

export interface ShowNoticeOptions {
  kind?: NoticeKind
  icon?: string
  /** Defaults to true. */
  autoDismiss?: boolean
}

export function useNotice() {
  const [notice, setNotice] = useState<NoticeData | null>(null)
  const nextId = useRef(0)

  const showNotice = useCallback((message: string, options: ShowNoticeOptions = {}) => {
    if (!message) return
    nextId.current += 1
    setNotice({
      id: nextId.current,
      kind: options.kind ?? 'error',
      message,
      icon: options.icon,
      autoDismiss: options.autoDismiss ?? true,
    })
  }, [])

  const dismissNotice = useCallback(() => setNotice(null), [])

  return { notice, showNotice, dismissNotice }
}
