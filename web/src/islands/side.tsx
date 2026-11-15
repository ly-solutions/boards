// The right island: «Комментарии · Чат». Comments are the board's threads (comments.tsx draws the list under these
// tabs); the chat is harnessly's chat with the agent — what is written here goes there, with the selection as context,
// and the agent answers in harnessly and edits the board in front of everyone.
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { Icon } from './icons'
import { selectedOf, textOf } from './scene'
import { useEditorTick, type Api } from './islands'
import type { Thread } from '../comments-model'

/** A thread that calls the agent: its first message has @harnessly (or @агент). */
const CALL = /(^|\s)@(harnessly|агент|agent)\b/i
const strip = (text: string) => text.replace(/(^|\s)@(harnessly|агент|agent)\b[\s,:]*/gi, ' ').trim()

/**
 * The chat outside harnessly (a board opened at its own address): a question goes to the agent as a comment thread
 * calling it, pinned to the selection — the agent that drew the board gets the board's comments in its conversation
 * and answers in the thread. Here those threads read as a chat.
 */
function ThreadChat({ api, threads, me }: { api: Api; threads: Thread[]; me: string | null }) {
  const now = Date.now()
  const asks = threads.filter((th) => CALL.test(th.messages[0]?.text ?? '')).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return (
    <>
      {asks.map((th) => {
        const last = th.messages[th.messages.length - 1]
        const typing = last && last.authorKind !== 'agent' && CALL.test(last.text) && now - Date.parse(last.at) < 120_000
        return (
          <div key={th.id} style={{ display: 'contents' }}>
            {th.messages.map((m) =>
              m.authorKind === 'agent' ? (
                <div key={m.id} className="isl-chat__am">
                  <p>{m.text}</p>
                  {m.ids && m.ids.length > 0 && (
                    <button type="button" className="isl-chat__show" onClick={() => showIds(api, m.ids!)}>
                      <Icon name="locate" size={13} />
                      {t('comments.showOnBoard')}
                    </button>
                  )}
                </div>
              ) : (
                <div key={m.id} className={`isl-chat__msg${m.author !== me && me ? ' isl-chat__msg--other' : ''}`}>
                  {strip(m.text)}
                </div>
              ),
            )}
            {typing && (
              <div className="isl-chat__typing">
                <span className="isl-agent__orb" aria-hidden="true" />
                {t('comments.agentTyping')}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

function showIds(api: Api, ids: string[]) {
  const want = new Set(ids)
  const els = (api.getSceneElements() as readonly { id: string }[]).filter((el) => want.has(el.id))
  if (els.length) api.scrollToContent(els as never, { fitToContent: els.length > 1, animate: true })
}

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

type Sent = { id: number; text: string; chip: string | null }

export function SideChat({ api, setSide, onAsk, threads = null, me = null, canAsk = true }: { api: Api; setSide: (s: 'comments' | 'chat' | null) => void; onAsk: (text: string, ids: string[]) => void; threads?: Thread[] | null; me?: string | null; canAsk?: boolean }) {
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
  const here = threads !== null
  const asked = here ? threads.filter((th) => CALL.test(th.messages[0]?.text ?? '')).reduce((n, th) => n + th.messages.length, 0) : sent.length
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [asked])
  const send = () => {
    const v = text.trim()
    if (!v) return
    onAsk(v, chip ? ids : [])
    if (!here) setSent((s) => [...s, { id: Date.now(), text: v, chip }])
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
        {here && <ThreadChat api={api} threads={threads} me={me} />}
        {!asked && (
          <div className="isl-chat__empty">
            <div className="isl-chat__orb" />
            {t('islands.chatEmpty')}
          </div>
        )}
        {!here && sent.map((m) => (
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
          disabled={!canAsk}
          value={text}
          placeholder={!canAsk ? t('islands.chatSignIn') : chip ? t('islands.chatAskSelection') : t('islands.chatPlaceholder')}
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
          <span className="isl-chat__hint">{here ? t('islands.chatHintHere') : t('islands.chatHint')}</span>
          <button type="button" className="isl-send" disabled={!text.trim()} onClick={send} aria-label={t('islands.send')}>
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}
