// The right island: «Комментарии · Чат». Comments are the board's threads (comments.tsx draws the list under these
// tabs); the chat is harnessly's chat with the agent — what is written here goes there, with the selection as context,
// and the agent answers in harnessly and edits the board in front of everyone.
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { Icon } from './icons'
import { selectedOf, textOf } from './scene'
import { useEditorTick, type Api } from './islands'

export function SideTabs({ side, setSide, app }: { side: 'comments' | 'chat' | null; setSide: (s: 'comments' | 'chat' | null) => void; app: boolean }) {
  if (!app) return null
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

type Sent = { id: number; text: string; chip: string | null }

export function SideChat({ api, setSide, onAsk }: { api: Api; setSide: (s: 'comments' | 'chat' | null) => void; onAsk: (text: string, ids: string[]) => void }) {
  useEditorTick(api)
  const [text, setText] = useState('')
  const [sent, setSent] = useState<Sent[]>([])
  const [dropped, setDropped] = useState('')
  const body = useRef<HTMLDivElement | null>(null)
  const sel = selectedOf(api)
  const ids = sel.map((e) => e.id)
  const key = ids.join(',')
  const words = sel
    .map((el) => (textOf(api, el)?.text ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ')
  const chip = sel.length && key !== dropped ? (words ? `${words.slice(0, 48)}${words.length > 48 ? '…' : ''}` : t('islands.objects', { count: sel.length })) : null
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [sent.length])
  const send = () => {
    const v = text.trim()
    if (!v) return
    onAsk(v, chip ? ids : [])
    setSent((s) => [...s, { id: Date.now(), text: v, chip }])
    setText('')
  }
  return (
    <aside className="isl-chat" aria-label={t('islands.chat')} onPointerDown={(e) => e.stopPropagation()}>
      <div className="isl-chat__head">
        <SideTabs side="chat" setSide={setSide} app />
        <button type="button" className="icon-button" onClick={() => setSide(null)} aria-label={t('islands.close')} title={t('islands.close')}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="isl-chat__body" ref={body}>
        {!sent.length && (
          <div className="isl-chat__empty">
            <div className="isl-chat__orb" />
            {t('islands.chatEmpty')}
          </div>
        )}
        {sent.map((m) => (
          <div key={m.id} style={{ display: 'contents' }}>
            {m.chip && (
              <span className="isl-chat__chip" style={{ alignSelf: 'flex-end' }}>
                <Icon name="pointer" size={12} />
                <span>{m.chip}</span>
              </span>
            )}
            <div className="isl-chat__msg">{m.text}</div>
            <div className="isl-chat__sent">{t('islands.chatSent')}</div>
          </div>
        ))}
      </div>
      <div className="isl-chat__comp">
        {chip && (
          <span className="isl-chat__chip">
            <Icon name="pointer" size={12} />
            <span>{chip}</span>
            <button type="button" aria-label={t('islands.dropSelection')} onClick={() => setDropped(key)}>
              <Icon name="x" size={12} />
            </button>
          </span>
        )}
        <textarea
          value={text}
          placeholder={chip ? t('islands.chatAskSelection') : t('islands.chatPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="isl-chat__row">
          <span className="isl-chat__hint">{t('islands.chatHint')}</span>
          <button type="button" className="isl-send" disabled={!text.trim()} onClick={send} aria-label={t('islands.send')}>
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}
