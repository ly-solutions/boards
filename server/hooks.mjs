/**
 * Outgoing webhooks. Today one stream: comment events, so agents and integrations can follow threads without
 * polling boards.
 *
 * Delivery never stands in the way of an edit: `emit` returns immediately, the POST runs in the background with a
 * timeout, and the outcome is only logged. There is no retry queue — a receiver that was down catches up by reading
 * the board text, which lists every open thread.
 */
export const COMMENT_EVENTS = ['thread.created', 'thread.replied', 'thread.resolved', 'thread.reopened', 'thread.removed']

export function createWebhook({ url = '', secret = '', timeoutMs = 5000, fetchImpl = globalThis.fetch, log = (entry) => console.error(JSON.stringify(entry)) } = {}) {
  const pending = new Set()

  function emit(payload) {
    if (!url) return null
    const delivery = (async () => {
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-boards-webhook-secret': secret },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) log({ level: 'warn', event: 'webhook_rejected', status: response.status, type: payload.event, slug: payload.slug })
      } catch (error) {
        log({ level: 'warn', event: 'webhook_failed', type: payload.event, slug: payload.slug, error: String(error?.message ?? error) })
      }
    })()
    pending.add(delivery)
    delivery.finally(() => pending.delete(delivery))
    return delivery
  }

  /** Wait for deliveries in flight (tests, graceful shutdown). */
  const settle = () => Promise.allSettled([...pending])

  return { enabled: Boolean(url), emit, settle }
}
