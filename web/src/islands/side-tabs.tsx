/** Tabs of the side panel: eager, while the chat itself (side.tsx) is a chunk loaded when it opens (HRN-1515). */
import { t } from '../i18n'

export function SideTabs({ side, setSide }: { side: 'comments' | 'chat' | null; setSide: (s: 'comments' | 'chat' | null) => void; app?: boolean }) {
  return (
    <div className="isl-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={side === 'comments'} className={side === 'comments' ? 'on' : ''} onClick={() => setSide('comments')}>
        {t('islands.comments')}
      </button>
      <button type="button" role="tab" aria-selected={side === 'chat'} className={side === 'chat' ? 'on' : ''} onClick={() => setSide('chat')}>
        {t('islands.chat')}
      </button>
    </div>
  )
}
