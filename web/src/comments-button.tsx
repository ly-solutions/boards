/**
 * What the board needs from comments before the comments themselves load: the island button and the draft for a
 * click. comments.tsx is a chunk of its own, loaded after the board (HRN-1515).
 */
import { BarButton, type StudioApi } from './studio'
import { draftFrom, type Draft, type SceneEl } from './comments-model'
import { t } from './i18n'
// Eager on purpose: the button and the pins must not flash unstyled while comments.tsx loads.
import './comments.css'

export const COMMENT_PATH = 'M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20l1.1-4.6A8.4 8.4 0 1 1 21 11.5z'

export function draftAt(api: StudioApi, x: number, y: number): Draft {
  return draftFrom(api.getSceneElements() as unknown as SceneEl[], x, y)
}

export function Glyph({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

/** Opens the comments panel; the badge counts open threads. Same look as every island button. */
export function CommentsButton({ count, open, onClick }: { count: number; open: boolean; onClick(): void }) {
  return (
    <BarButton label={count ? t('comments.buttonOpen', { count }) : t('comments.title')} on={open} onClick={onClick}>
      <Glyph d={COMMENT_PATH} size={18} />
      {count > 0 && <span className="note-count">{count > 99 ? '99+' : count}</span>}
    </BarButton>
  )
}
