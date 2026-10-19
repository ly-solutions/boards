/**
 * Live channel socket with reconnects.
 *
 * The channel is an accelerator, not the only path: without it the editor syncs
 * by polling `/sync`. So there is no outgoing queue here — the editor resends
 * whatever didn't go through by comparing element versions with acknowledged ones.
 */
export type LiveMessage = { t: string; [key: string]: unknown }

type Handlers = {
  onOpen(): void
  onMessage(message: LiveMessage): void
  onClose(): void
  /** No reply to an edit: the channel is suspect, so duplicate the edits via polling right away. */
  onStall?(): void
}

/** Cursors and selection aren't worth queueing behind a slow channel. */
const VOLATILE_BACKLOG = 256 * 1024

/**
 * Channel watchdog. Browsers don't report a silently dead socket: after laptop
 * sleep, a Wi-Fi switch or a mobile network drop, `readyState` stays OPEN for
 * minutes. Meanwhile the editor believed it was live, turned polling off, sent
 * edits into the void and kept other people's cursors frozen.
 *
 * So we check liveness ourselves: silence longer than PING_AFTER → send a ping,
 * the server answers pong; no answer within PROBE_DEADLINE → the channel is
 * dead, drop it and reconnect without waiting for TCP. We also check right away
 * when the tab becomes visible or the network comes back.
 *
 * Timeouts of 15 and 35 seconds proved too long: someone typed into a sticky,
 * the channel died silently, nobody saw the text for half a minute and then it
 * appeared all at once. Now the editing side learns about a drop from its own
 * edits: the server acks an edit within tens of milliseconds, so if nothing at
 * all arrives within ACK_WAIT we probe immediately and duplicate the edits via
 * polling without waiting for the result. A viewer probes after five seconds
 * of silence.
 *
 * A slow but live channel is not dropped: any server message clears the probe,
 * not just the pong.
 */
const WATCH_EVERY_MS = 2_000
const PING_AFTER_MS = 5_000
const DEAD_AFTER_MS = 20_000
const PROBE_DEADLINE_MS = 4_000
const ACK_WAIT_MS = 2_000
const CONNECT_TIMEOUT_MS = 10_000

/** Why the channel dropped — sent to the server with the next hello, for its log. */
export type DropReason = 'closed' | 'no-reply' | 'silence' | 'handshake'

export class LiveChannel {
  private ws: WebSocket | null = null
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private lastHeardAt = 0
  private openedAt = 0
  private watchTimer: ReturnType<typeof setInterval> | undefined
  private probeTimer: ReturnType<typeof setTimeout> | undefined
  private ackTimer: ReturnType<typeof setTimeout> | undefined
  public connected = false
  /** Reason for the last drop and how long that socket lived — for the server log. */
  public lastDrop: { reason: DropReason; aliveMs: number } | null = null

  public constructor(
    private readonly url: () => string,
    private readonly handlers: Handlers,
  ) {}

  public start(): void {
    this.stopped = false
    window.addEventListener('online', this.reconnectNow)
    document.addEventListener('visibilitychange', this.onVisible)
    this.watchTimer = setInterval(this.watch, WATCH_EVERY_MS)
    this.open()
  }

  public stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.probeTimer)
    clearTimeout(this.ackTimer)
    clearInterval(this.watchTimer)
    window.removeEventListener('online', this.reconnectNow)
    document.removeEventListener('visibilitychange', this.onVisible)
    this.ws?.close()
  }

  public send(message: LiveMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(message))
    if (message.t === 'push') this.expectReply()
    return true
  }

  /** After an edit expect anything from the server; silence means probe now rather than after PING_AFTER. */
  private expectReply(): void {
    if (this.ackTimer) return
    const sentAt = Date.now()
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined
      if (!this.connected || this.lastHeardAt > sentAt) return
      this.handlers.onStall?.()
      this.probe()
    }, ACK_WAIT_MS)
  }

  /** Lightweight message: if the channel is backed up, it's cheaper to skip than to catch up. */
  public sendVolatile(message: LiveMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < VOLATILE_BACKLOG) this.ws.send(JSON.stringify(message))
  }

  private open(): void {
    if (this.stopped || this.ws) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url())
    } catch {
      this.retry()
      return
    }
    this.ws = ws
    this.openedAt = Date.now()
    ws.onopen = () => {
      this.attempt = 0
      this.connected = true
      this.lastHeardAt = Date.now()
      this.handlers.onOpen()
    }
    ws.onmessage = (event) => {
      this.lastHeardAt = Date.now()
      clearTimeout(this.probeTimer)
      this.probeTimer = undefined
      let message: LiveMessage
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.t === 'pong') return
      this.handlers.onMessage(message)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.drop('closed')
    }
  }

  /**
   * Abandon the current socket and reconnect. Handlers are detached before close():
   * a dead connection's onclose may fire minutes later and must not close the
   * new socket by then.
   */
  private drop(reason: DropReason): void {
    const ws = this.ws
    const was = this.connected
    this.ws = null
    this.connected = false
    // Keep the first reason per outage: failed reconnect attempts that follow must not overwrite it.
    this.lastDrop ??= { reason, aliveMs: Date.now() - this.openedAt }
    clearTimeout(this.probeTimer)
    this.probeTimer = undefined
    clearTimeout(this.ackTimer)
    this.ackTimer = undefined
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        // Already closed.
      }
    }
    if (was) this.handlers.onClose()
    this.retry()
  }

  private readonly watch = (): void => {
    if (this.stopped || !this.ws) return
    const now = Date.now()
    if (!this.connected) {
      // A hanging handshake is a drop too: the proxy accepted TCP and went silent.
      if (now - this.openedAt > CONNECT_TIMEOUT_MS) this.drop('handshake')
      return
    }
    const silence = now - this.lastHeardAt
    // Backstop: background tabs are woken rarely, so the probe and its deadline may not have run.
    if (silence > DEAD_AFTER_MS) this.drop('silence')
    else if (silence > PING_AFTER_MS) this.probe()
  }

  /** Quick probe: an answer within PROBE_DEADLINE means alive, otherwise reconnect. */
  private probe(): void {
    // A probe is already running — don't extend its deadline, or frequent probes would never let it expire.
    if (this.probeTimer || !this.connected || !this.send({ t: 'ping' })) return
    this.probeTimer = setTimeout(() => this.drop('no-reply'), PROBE_DEADLINE_MS)
  }

  private retry(): void {
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    // 0.5 → 1 → 2 → … → 10 s with jitter: after a deploy all tabs must not hit
    // the new server in the same millisecond.
    const delay = Math.min(10_000, 500 * 2 ** this.attempt) * (0.7 + Math.random() * 0.6)
    this.attempt += 1
    this.retryTimer = setTimeout(() => this.open(), delay)
  }

  private readonly reconnectNow = (): void => {
    if (this.stopped) return
    if (this.connected) return this.probe()
    clearTimeout(this.retryTimer)
    this.attempt = 0
    this.open()
  }

  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible') this.reconnectNow()
  }
}
