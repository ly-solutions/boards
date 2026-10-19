/**
 * Minimal Prometheus metrics without a dependency. Served on a separate port (BOARDS_METRICS_PORT) so the public
 * ingress never exposes them.
 */

/** Collapse a path into a low-cardinality route label: `/b/<slug>/edit` → `/b/:slug/edit`. */
export function routeLabel(url = '') {
  const path = String(url).split('?')[0]
  if (path === '/healthz' || path === '/readyz' || path === '/') return path
  if (path.startsWith('/b/_static/')) return '/b/_static'
  if (path.startsWith('/b/api/boards/')) return '/b/api/boards/:slug'
  if (path.startsWith('/b/api/templates/')) return '/b/api/templates/:id'
  if (/^\/b\/(api|auth)(\/|$)/.test(path)) return path.replace(/\/+$/, '')
  if (path === '/b/' || path === '/b') return '/b/'
  const m = /^\/b\/[a-z0-9-]+(\.md|\.json)?(\/([a-z.]+))?/.exec(path)
  if (m) return `/b/:slug${m[1] ?? ''}${m[3] ? `/${m[3]}` : ''}`
  return 'other'
}

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const labels = (obj) => {
  const parts = Object.entries(obj).map(([k, v]) => `${k}="${esc(v)}"`)
  return parts.length ? `{${parts.join(',')}}` : ''
}

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export function createMetrics() {
  const counters = new Map()
  const gauges = new Map()
  const histogram = new Map()
  const help = new Map()

  function inc(name, description, labelValues = {}, by = 1) {
    help.set(name, ['counter', description])
    const key = `${name}${labels(labelValues)}`
    counters.set(key, (counters.get(key) ?? 0) + by)
  }

  function gauge(name, description, read) {
    help.set(name, ['gauge', description])
    gauges.set(name, read)
  }

  function request(req, status, seconds) {
    const route = routeLabel(req.url)
    inc('boards_http_requests_total', 'HTTP requests by route, method and status.', { route, method: req.method, status })
    const key = `${route}|${req.method}`
    let h = histogram.get(key)
    if (!h) histogram.set(key, (h = { route, method: req.method, counts: BUCKETS.map(() => 0), sum: 0, count: 0 }))
    for (let i = 0; i < BUCKETS.length; i += 1) if (seconds <= BUCKETS[i]) h.counts[i] += 1
    h.sum += seconds
    h.count += 1
  }

  function render() {
    const out = []
    const seen = new Set()
    const header = (name) => {
      if (seen.has(name)) return
      seen.add(name)
      const [type, description] = help.get(name) ?? ['untyped', '']
      out.push(`# HELP ${name} ${description}`, `# TYPE ${name} ${type}`)
    }
    for (const [key, value] of counters) {
      header(key.split('{')[0])
      out.push(`${key} ${value}`)
    }
    for (const [name, read] of gauges) {
      header(name)
      let value = 0
      try {
        value = Number(read()) || 0
      } catch {
        value = 0
      }
      out.push(`${name} ${value}`)
    }
    out.push('# HELP boards_http_request_duration_seconds Request latency.', '# TYPE boards_http_request_duration_seconds histogram')
    for (const h of histogram.values()) {
      BUCKETS.forEach((le, i) => out.push(`boards_http_request_duration_seconds_bucket${labels({ route: h.route, method: h.method, le })} ${h.counts[i]}`))
      out.push(`boards_http_request_duration_seconds_bucket${labels({ route: h.route, method: h.method, le: '+Inf' })} ${h.count}`)
      out.push(`boards_http_request_duration_seconds_sum${labels({ route: h.route, method: h.method })} ${h.sum}`)
      out.push(`boards_http_request_duration_seconds_count${labels({ route: h.route, method: h.method })} ${h.count}`)
    }
    const mem = process.memoryUsage()
    out.push('# HELP process_resident_memory_bytes Resident memory.', '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`)
    return `${out.join('\n')}\n`
  }

  return { inc, gauge, request, render }
}
