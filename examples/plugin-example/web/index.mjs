/**
 * The example plugin's editor half. Loaded by the editor as an ES module; no build step, no dependencies.
 *
 * - draws `github.issue` cards (the server resolver returns them) with a coloured state pill;
 * - adds a toolbar button that shows the board's deadline, if the person has the `example-beta` flag.
 */
export const apiVersion = '^1.0.0'

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = text
  return node
}

/** @param {import('../../../types/plugin').WebPluginApi} api */
export function register(api) {
  api.addMessages('en', { 'example.noDeadline': 'No deadline set — add one in Board properties', 'example.deadlineIs': 'Deadline: {date}', 'example.showDeadline': 'Deadline' })
  api.addMessages('ru', { 'example.noDeadline': 'Дедлайн не задан — добавьте его в свойствах доски', 'example.deadlineIs': 'Дедлайн: {date}', 'example.showDeadline': 'Дедлайн' })

  api.registerCardRenderer('github.issue', (root, card) => {
    const head = el('span', 'link-card__head')
    if (card.icon) {
      const icon = el('img', 'link-glyph')
      icon.src = card.icon
      icon.alt = ''
      head.append(icon)
    }
    head.append(el('span', 'link-card__kind', card.site))
    if (card.status) head.append(el('span', `link-card__status link-card__status--${card.status.tone}`, card.status.label))
    root.append(head, el('span', 'link-card__title', card.title))
    const foot = [card.subtitle, ...(card.fields ?? []).map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join(' · ')
    if (foot) root.append(el('span', 'link-card__foot', foot))
  })

  const format = (value) => new Date(`${value}T00:00:00Z`).toLocaleDateString(api.locale === 'ru' ? 'ru-RU' : undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  api.registerMetaField({ id: 'deadline', format })

  if (api.isEnabled('example-beta')) {
    api.registerToolbarButton({
      id: 'example-deadline',
      label: api.t('example.showDeadline'),
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14v15H5zM5 9h14M9 3v4M15 3v4"/></svg>',
      onClick: ({ api }) => {
        const deadline = api.board.fields.deadline
        api.editor.toast(deadline ? api.t('example.deadlineIs', { date: format(deadline) }) : api.t('example.noDeadline'))
      },
    })
  }
}
