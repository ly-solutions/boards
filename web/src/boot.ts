/**
 * Runs before the editor or the embed view (it is the first module script on both pages).
 *
 * 1. Tells Excalidraw where its fonts are. The base is derived from this module's own URL rather than from
 *    `location`, so it is right on any host and inside a sandboxed iframe with an opaque origin.
 * 2. On the editor page, starts downloading the scene right away instead of after ~1.5 MB of editor code has been
 *    parsed; the editor picks the promise up from `window.__boardScene`. The URL matches the page's preload hint.
 */
const staticBase = new URL('../', import.meta.url).href
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = staticBase

const configNode = document.getElementById('board-config')
if (configNode) {
  try {
    const config = JSON.parse(configNode.textContent ?? '{}') as { slug?: string; key?: string; at?: { id: string } | null }
    if (config.slug && config.key) {
      const path = config.at?.id ? `checkpoints/${config.at.id}/scene` : 'scene.excalidraw'
      const url = `/b/${config.slug}/${path}?k=${encodeURIComponent(config.key)}`
      ;(window as unknown as { __boardScene?: Promise<unknown> }).__boardScene = fetch(url, { credentials: 'same-origin', mode: 'cors' }).then((response) => {
        if (!response.ok) throw new Error(`scene: HTTP ${response.status}`)
        return response.json()
      })
    }
  } catch {
    // A broken config is reported by the editor itself.
  }
}
