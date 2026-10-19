/**
 * Right-click menu: our own instead of the stock Excalidraw one.
 *
 * The stock menu is long and about the editor's capabilities in general ("copy
 * as SVG", "zen mode", "stats for nerds"). Ours is about working on the board:
 * comment, sticky and a short set of edits.
 *
 * The editor still opens its own menu — it is just hidden (editor.css). Edits
 * run by clicking its own item: so Paste, Duplicate and layer order stay real
 * editor actions — with undo history and all its checks — not our copy. Which
 * items fit what was clicked is also the editor's call: we only show what its
 * menu has.
 *
 * Nothing from the stock menu is lost: whatever is not in the short list sits
 * under "More" with the editor's own labels, shortcuts and checkmarks — snap
 * to objects, grid, styles, copy as PNG.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import { hostOf } from './links'
import type { StudioApi } from './studio'
import { useFit } from './popover'

/** What the editor opened: screen position, scene point and what is selected under the cursor. */
export type MenuState = { left: number; top: number; at: { x: number; y: number }; ids: string[] }

const NATIVE = '.excalidraw .context-menu'
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = MAC ? '⌘' : 'Ctrl+'

/**
 * Labels for the "More" section. The editor provides its own, but some are
 * heavy ("Copy to clipboard as PNG") or vague ("Toggle grid"). Anything not
 * listed here shows the editor's label.
 */
const MORE_LABEL: Record<string, string> = {
  paste: 'Paste',
  copyAsPng: 'Copy as PNG',
  copyAsSvg: 'Copy as SVG',
  copyText: 'Copy as text',
  copyStyles: 'Copy styles',
  pasteStyles: 'Paste styles',
  group: 'Group',
  ungroup: 'Ungroup',
  unbindText: 'Unbind text from shape',
  bindText: 'Bind text to shape',
  wrapTextInContainer: 'Wrap text in a shape',
  addToLibrary: 'Add to library',
  sendBackward: 'Send backward',
  bringForward: 'Bring forward',
  flipHorizontal: 'Flip horizontal',
  flipVertical: 'Flip vertical',
  copyElementLink: 'Copy link to block',
  wrapSelectionInFrame: 'Wrap in frame',
  selectAllElementsInFrame: 'Select all in frame',
  removeAllElementsFromFrame: 'Remove all from frame',
  unlockAllElements: 'Unlock all',
  gridMode: 'Grid',
  objectsSnapMode: 'Snap to objects',
  zenMode: 'Zen mode',
  viewMode: 'View mode',
  stats: 'Canvas and shape properties',
}

type Props = {
  api: StudioApi
  menu: MenuState
  onClose: () => void
  onComment: (at: { x: number; y: number }) => void
  onSticky: (at: { x: number; y: number }) => void
}

const icon = (d: string) => (
  <svg className="board-menu__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)
const ICON = {
  link: icon('M10 14a4.5 4.5 0 0 0 6.4 0l3-3A4.5 4.5 0 0 0 13 4.6l-1.2 1.2 M14 10a4.5 4.5 0 0 0-6.4 0l-3 3A4.5 4.5 0 0 0 11 19.4l1.2-1.2'),
  more: icon('M5 12h.01 M12 12h.01 M19 12h.01'),
  comment: icon('M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12Z'),
  sticky: icon('M5 4h14a1 1 0 0 1 1 1v9l-6 6H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M20 14h-5a1 1 0 0 0-1 1v5'),
  copy: icon('M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'),
  cut: icon('M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M20 4 8.1 15.9 M14.5 14.5 20 20 M8.1 8.1 12 12'),
  paste: icon('M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1Z M16 5h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2'),
  duplicate: icon('M8 8h12v12H8Z M16 8V4H4v12h4 M14 11v6 M11 14h6'),
  front: icon('M12 3 3 8l9 5 9-5-9-5Z M3 13l9 5 9-5 M12 21V13'),
  back: icon('M12 21 3 16l9-5 9 5-9 5Z M3 11l9-5 9 5 M12 3v8'),
  group: icon('M4 4h7v7H4Z M13 13h7v7h-7Z M4 16v4h4 M20 8V4h-4'),
  lock: icon('M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z M8 11V7a4 4 0 0 1 8 0v4'),
  select: icon('M4 4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M4 8v0 M9 9h6v6H9Z'),
  trash: icon('M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3'),
}

type Item = { key: string; label: string; icon: ReactNode; hint?: string; danger?: boolean; run: () => void } | 'sep'
/** An item of the editor's stock menu as it rendered it: label and shortcut are its own, in the UI language. */
type Native = { name: string; label: string; hint: string; checked: boolean } | 'sep'

export function BoardMenu({ api, menu, onClose, onComment, onSticky }: Props) {
  // The editor decided which edits fit: read them from its hidden menu.
  const [nativeItems, setNativeItems] = useState<Native[]>([])
  useLayoutEffect(() => {
    const list = [...(document.querySelector(NATIVE)?.children ?? [])].map((node): Native =>
      node.tagName === 'HR'
        ? 'sep'
        : {
            name: node.getAttribute('data-testid') ?? '',
            label: MORE_LABEL[node.getAttribute('data-testid') ?? ''] ?? node.querySelector('.context-menu-item__label')?.textContent?.trim() ?? '',
            hint: node.querySelector('kbd')?.textContent?.trim() ?? '',
            checked: Boolean(node.querySelector('.checkmark')),
          },
    )
    setNativeItems(list)
    setMore(null)
  }, [menu])
  const native = new Set(nativeItems.flatMap((item) => (item === 'sep' ? [] : [item.name])))
  const { ref, pos } = useFit(menu, [native.size])
  // "More": everything in the stock menu that is not in the short list. Opens beside its item.
  const [more, setMore] = useState<{ top: number } | null>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [subShift, setSubShift] = useState<{ left: boolean; up: number }>({ left: false, up: 0 })
  useLayoutEffect(() => {
    if (!more) return setSubShift({ left: false, up: 0 })
    const box = subRef.current?.getBoundingClientRect()
    const host = ref.current?.getBoundingClientRect()
    if (!box || !host) return
    setSubShift({ left: host.right + 6 + box.width > window.innerWidth - 8, up: Math.max(0, host.top + more.top + box.height - (window.innerHeight - 8)) })
  }, [more, ref])

  /** Close both menus: ours and the hidden stock one. */
  const close = () => {
    api.updateScene({ appState: { contextMenu: null }, captureUpdate: CaptureUpdateAction.NEVER })
    onClose()
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    const el = ref.current
    // A press inside our menu must not reach the document: the editor would take it for a
    // click outside and remove its menu before we click an item in it.
    const hold = (e: Event) => e.stopPropagation()
    el?.addEventListener('pointerdown', hold)
    const onDown = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    const onAway = () => closeRef.current()
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onAway, { capture: true, passive: true })
    window.addEventListener('blur', onAway)
    return () => {
      el?.removeEventListener('pointerdown', hold)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onAway, true)
      window.removeEventListener('blur', onAway)
    }
  }, [ref])

  /** A real editor action: click the item in its menu, which then closes itself. */
  const act = (name: string) => () => {
    const li = document.querySelector<HTMLElement>(`${NATIVE} > li[data-testid="${name}"]`)
    if (li) li.click()
    else api.updateScene({ appState: { contextMenu: null }, captureUpdate: CaptureUpdateAction.NEVER })
    onClose()
  }
  /** Our own action: we close the stock menu ourselves. */
  const own = (run: () => void) => () => {
    close()
    run()
  }

  const selected = api.getSceneElements().filter((el) => menu.ids.includes(el.id))
  const onBlock = selected.length > 0 && native.has('deleteSelectedElements')
  // A shape's label counts together with the shape.
  const hosts = new Set(selected.map((el) => hostOf(api, el.id)?.id).filter(Boolean) as string[])
  const host = hosts.size === 1 ? hostOf(api, [...hosts][0]) : null
  const locked = selected.length > 0 && selected.every((el) => (el as { locked?: boolean }).locked)

  const items: Item[] = []
  const used = new Set<string>()
  const add = (name: string, label: string, ic: ReactNode, hint?: string, danger?: boolean) => {
    if (!native.has(name)) return
    used.add(name)
    items.push({ key: name, label, icon: ic, hint, danger, run: act(name) })
  }
  if (onBlock) {
    // The block link is a real editor action: it opens the editor's URL popup.
    if (hosts.size === 1) add('hyperlink', (host as { link?: string | null } | null)?.link ? 'Edit link…' : 'Link…', ICON.link, `${MOD}K`)
    items.push({ key: 'comment', label: 'Comment', icon: ICON.comment, run: own(() => onComment(menu.at)) })
    items.push('sep')
    add('copy', 'Copy', ICON.copy, `${MOD}C`)
    add('cut', 'Cut', ICON.cut, `${MOD}X`)
    add('duplicateSelection', 'Duplicate', ICON.duplicate, `${MOD}D`)
    items.push('sep')
    add('bringToFront', 'Bring to front', ICON.front)
    add('sendToBack', 'Send to back', ICON.back)
    // The editor offers grouping for a single labelled shape too — pointless.
    if (hosts.size > 1) add('group', 'Group', ICON.group, `${MOD}G`)
    add('ungroup', 'Ungroup', ICON.group)
    add('toggleElementLock', locked ? 'Unlock' : 'Lock in place', ICON.lock)
    items.push('sep')
    add('deleteSelectedElements', 'Delete', ICON.trash, 'Del', true)
  } else {
    add('paste', 'Paste', ICON.paste, `${MOD}V`)
    items.push({ key: 'sticky', label: 'Sticky here', icon: ICON.sticky, run: own(() => onSticky(menu.at)) })
    items.push({ key: 'comment', label: 'Comment here', icon: ICON.comment, run: own(() => onComment(menu.at)) })
    items.push('sep')
    add('selectAll', 'Select all', ICON.select, `${MOD}A`)
    add('toggleElementLock', 'Unlock', ICON.lock)
  }
  // No separator at the start or end, and never two in a row.
  const tidy = <T,>(list: (T | 'sep')[]) => {
    const out = list.filter((item, i, all) => item !== 'sep' || (i > 0 && all[i - 1] !== 'sep'))
    while (out[out.length - 1] === 'sep') out.pop()
    while (out[0] === 'sep') out.shift()
    return out
  }
  const shown = tidy(items)
  const rest = tidy(nativeItems.filter((item) => item === 'sep' || (item.name && item.label && !used.has(item.name))))
  // Delete stays last and apart: "More" goes before its separator.
  const tail = shown.length && shown[shown.length - 1] !== 'sep' && (shown[shown.length - 1] as Exclude<Item, 'sep'>).danger ? shown.splice(-2) : []

  const row = (item: Item, i: number) =>
    item === 'sep' ? (
      <hr key={`sep-${i}`} className="board-menu__sep" />
    ) : (
      <button key={item.key} type="button" role="menuitem" className={`board-menu__item${item.danger ? ' is-danger' : ''}`} onClick={item.run} onMouseEnter={() => setMore(null)}>
        {item.icon}
        <span className="board-menu__label">{item.label}</span>
        {item.hint && <kbd className="board-menu__hint">{item.hint}</kbd>}
      </button>
    )

  return createPortal(
    <div className="board-menu" ref={ref} style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {shown.map(row)}
      {rest.length > 0 && (
        <>
          {shown.length > 0 && <hr className="board-menu__sep" />}
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={Boolean(more)}
            className={`board-menu__item${more ? ' is-open' : ''}`}
            onMouseEnter={(e) => setMore({ top: e.currentTarget.offsetTop })}
            onClick={(e) => setMore(more ? null : { top: e.currentTarget.offsetTop })}
          >
            {ICON.more}
            <span className="board-menu__label">More</span>
            <span className="board-menu__chevron" aria-hidden>
              ›
            </span>
          </button>
        </>
      )}
      {tail.map((item, i) => row(item, 1000 + i))}
      {more && (
        <div className={`board-menu board-menu__sub${subShift.left ? ' is-left' : ''}`} ref={subRef} style={{ top: more.top - 6 - subShift.up }} role="menu">
          {rest.map((item, i) =>
            item === 'sep' ? (
              <hr key={`sep-${i}`} className="board-menu__sep" />
            ) : (
              <button key={item.name} type="button" role="menuitemcheckbox" aria-checked={item.checked} className="board-menu__item" onClick={act(item.name)}>
                <span className="board-menu__check" aria-hidden>
                  {item.checked ? '✓' : ''}
                </span>
                <span className="board-menu__label">{item.label}</span>
                {item.hint && <kbd className="board-menu__hint">{item.hint}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}
