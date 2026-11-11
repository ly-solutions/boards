(function () {
// @harnessly/app-sdk: what a view of a Harnessly app uses to talk to the host. One file, no dependencies, served by the
// runtime at /__hl/app-sdk.js to every view. The wire is MCP Apps (JSON-RPC 2.0 over postMessage: ui/initialize,
// tools/call, ui/message, notifications) plus the host's own methods under harnessly/.
//
//   <script src="/__hl/app-sdk.js"></script>        the view server's app-sdk.js is a classic script: harnessly.connect()
//   import { connect } from '/__hl/app-sdk.mjs'     the module; an import from app-sdk.js there finds nothing
//   const hl = await connect()
// (`harnessly app sdk DIR` writes this file as it is, a module, for a view on the app's own server.)
//
// The view server puts /__hl/bridge-shim.js first in every page it serves. The shim makes the handshake with the nonce of
// the page and takes the host's MessageChannel port; it replaces window.parent with a stand-in that speaks on the port,
// so this file (like any standard MCP Apps view) just posts to window.parent and listens to `message`.

const PROTOCOL = '2025-11-21';
// The versions of Harnessly's own protocol this SDK speaks (internal/apps/surface.go SDKProtocols). A view asks for one
// with connect({ protocol }); 1, the default, behaves as it always did.
const HL_PROTOCOLS = [1, 2];

// What a refusal is called in protocol 2: the app may not (denied), the host cannot here (unsupported), or it failed.
const DENIED = ['permission_denied', 'not_in_target', 'policy_blocked', 'network_denied', 'host_not_allowed'];
const refusalOf = (e) => {
  const code = e?.code || 'host_unavailable';
  let kind = 'failed';
  if (DENIED.includes(code)) kind = 'denied';
  else if (code === 'host_unavailable' || /removed from the SDK|method not found|no method/.test(e?.message || '')) kind = 'unsupported';
  const out = { error: kind, code, message: e?.message || code };
  if (typeof e?.version === 'number') out.version = e.version;
  if (e?.signIn) out.signIn = e.signIn;
  return out;
};
const isRefusal = (v) => v !== null && typeof v === 'object' && typeof v.error === 'string' && typeof v.code === 'string';

// Protocol 2: every method of hl answers a refusal as a value ({ error, code, message }) instead of rejecting, so a view
// that does not catch keeps working. hl.on, hl.has, hl.refused, hl.resize, hl.close and the surface (hl.state, hl.action,
// hl.screen: they answer handles, not promises) are left as they are.
const KEEP = new Set(['on', 'has', 'refused', 'resize', 'close', 'context', 'host', 'state', 'action', 'screen']);
const answerRefusals = (obj, top) => {
  for (const [key, v] of Object.entries(obj)) {
    if (top && KEEP.has(key)) continue;
    if (typeof v === 'function') {
      obj[key] = (...args) => {
        try {
          const out = v.apply(obj, args);
          if (!out || typeof out.then !== 'function') return out;
          const answered = out.catch(refusalOf);
          // hl.tools.register's promise carries unregister.
          if (typeof out.unregister === 'function') answered.unregister = out.unregister;
          return answered;
        } catch (e) {
          return Promise.resolve(refusalOf(e));
        }
      };
    } else if (v && typeof v === 'object' && !Array.isArray(v)) answerRefusals(v, false);
  }
};

// What hl.has accepts besides a bridge method's own name: the SDK's names of the MCP Apps methods.
const HAS_ALIAS = {
  'chat.send': 'ui/message',
  'tools.call': 'tools/call',
  'resize': 'ui/notifications/size-changed',
  'openLink': 'ui/open-link',
  'publish': 'harnessly/context.publish',
  'events.on': 'harnessly/events.subscribe',
};
const TIMEOUT_MS = 30_000;

// The agent's calls this view has run, with their answers: the last RAN_KEPT, in memory and, where the
// browser allows, in sessionStorage, so a call that comes again after a reload of the view is answered, not run again.
const RAN_KEPT = 50;
const RAN_KEY = 'harnessly.ran-calls';
const recallRan = () => {
  const ran = new Map();
  try {
    const kept = JSON.parse(sessionStorage.getItem(RAN_KEY) ?? '[]');
    if (Array.isArray(kept)) {
      for (const body of kept.slice(-RAN_KEPT)) if (typeof body?.id === 'string') ran.set(body.id, body);
    }
  } catch {
    // A sandboxed view has no storage of its own: the memory of this load is all there is.
  }
  return ran;
};
const rememberRan = (ran, id, body) => {
  ran.set(id, body);
  for (const old of ran.keys()) {
    if (ran.size <= RAN_KEPT) break;
    ran.delete(old);
  }
  try {
    sessionStorage.setItem(RAN_KEY, JSON.stringify([...ran.values()]));
  } catch {
    // No storage, or an answer too large for it.
  }
};

// A Blob's bytes as base64, by chunks (a spread of a large array overflows the stack).
const base64Of = async (blob) => {
  const buf =
    typeof blob?.arrayBuffer === 'function'
      ? await blob.arrayBuffer()
      : await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new HarnesslyError('invalid_params', 'the file cannot be read'));
          reader.readAsArrayBuffer(blob);
        });
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** The error every failed call throws; `code` says why (see HarnesslyErrorCode in app-sdk.d.ts). */
class HarnesslyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'HarnesslyError';
    this.code = code;
  }
}

// The host answers with a JSON-RPC error whose data.code is ours; an error without one is the host being unavailable.
const errorOf = (e) => {
  const err = new HarnesslyError(e?.data?.code || 'host_unavailable', e?.message);
  // A conflict says the version the key has now.
  if (typeof e?.data?.version === 'number') err.version = e.data.version;
  // A refused sign-in says where the person signs in (the host shows «Войти»; the view cannot sign in by itself).
  const signIn = e?.data?.signIn;
  if (signIn !== null && typeof signIn === 'object') err.signIn = { ...signIn };
  return err;
};

// The host speaks MCP Apps' host context (theme as the mode, styles.variables) and carries its own whole context under
// `harnessly`: that is what `hl.context` is.
const ctxOf = (host) => host?.harnessly ?? host ?? {};

const STORAGE_SCOPES = ['install', 'user', 'chat', 'space', 'doc'];

/**
 * Handshake with the host. Throws HarnesslyError('host_unavailable') when the view is not inside a Harnessly frame or
 * the host does not answer.
 */
// The view's errors and console.error lines go to the host's debug section (harnessly/debug.log): kept from the moment
// the SDK loads, sent once the view is connected. A few, short: it is a hint for the author, not a log store.
const debugQueue = [];
let debugSend = null;
const debugLog = (level, text) => {
  const line = { level, text: String(text).slice(0, 2000) };
  if (debugSend) debugSend(line);
  else if (debugQueue.length < 20) debugQueue.push(line);
};
const debugText = (v) => {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) =>
    debugLog('error', `${e.message || 'error'}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`),
  );
  window.addEventListener('unhandledrejection', (e) => debugLog('error', `unhandled: ${debugText(e.reason)}`));
  window.addEventListener('securitypolicyviolation', (e) =>
    debugLog('error', `CSP blocked ${e.blockedURI || 'inline'} by ${e.violatedDirective}`),
  );
  for (const level of ['error', 'warn']) {
    const own = console[level];
    console[level] = (...args) => {
      debugLog(level, args.map(debugText).join(' '));
      own.apply(console, args);
    };
  }
}

// The agent's surface of a page: states (a form's value the agent reads and patches), actions (a function of
// the screen the agent runs) and the screen itself. It is the module's own, not a connection's: state(), action() and
// screen() may be called before connect() answers (they wait for the handshake) and outside Harnessly (they wait for
// good, and nothing is sent). Every tool answers one shape: { ok, value | result, issues }.
const ISSUE_SOURCES = ['form', 'rule', 'server'];
const SURFACE_DEBOUNCE_MS = 300;
const TOOL_DESCRIPTION_MAX = 1000;
const surface = { host: null, screen: null, states: new Map(), actions: new Map(), own: undefined, timer: 0 };

// One issue in the shape the agent gets; `forced` is the source the SDK knows better than the author (a rule's check).
const issueOf = (raw, fallback, forced) => {
  const given = raw !== null && typeof raw === 'object' ? raw : { message: raw };
  let source = fallback;
  if (forced) source = forced;
  else if (ISSUE_SOURCES.includes(given.source)) source = given.source;
  const issue = {
    source,
    field: typeof given.field === 'string' ? given.field : '',
    level: given.level === 'warn' ? 'warn' : 'error',
    message: String(given.message ?? ''),
  };
  if (typeof given.rule === 'string') issue.rule = given.rule;
  return issue;
};
// What a set, a run or a check gave: an array of issues, or an object that carries one under `issues`.
const issuesIn = (out) => {
  if (Array.isArray(out)) return out;
  if (out !== null && typeof out === 'object' && Array.isArray(out.issues)) return out.issues;
  return [];
};
// An error's words; one thrown in another frame of the site is no instance of this window's Error.
const wordsOf = (e) => (typeof e?.message === 'string' ? e.message : String(e));
// What a throw says: the issues it carries, or one issue with its message.
const issuesThrown = (e) => {
  if (Array.isArray(e?.issues)) return e.issues;
  return [{ source: e?.source, field: e?.field, message: wordsOf(e) }];
};
// Runs fn and adds every issue it returned or threw; answers what fn returned (undefined when it threw).
const gather = async (issues, fn, fallback, forced) => {
  try {
    const out = await fn();
    for (const raw of issuesIn(out)) issues.push(issueOf(raw, fallback, forced));
    return out;
  } catch (e) {
    for (const raw of issuesThrown(e)) issues.push(issueOf(raw, fallback, forced));
    return undefined;
  }
};
const passed = (issues) => !issues.some((i) => i.level === 'error');
// The rules in words, as the tool's description carries them (the context carries them whole).
const rulesText = (rules) => rules.map((r) => `\n- [${r.id}] ${r.text}`).join('');
const describeTool = (lead, def) => {
  const rules = def.rules.length > 0 ? `\nRules:${rulesText(def.rules)}` : '';
  return `${lead}${rules}`.slice(0, TOOL_DESCRIPTION_MAX);
};
const warnSurface = (what, e) => console.warn(`harnessly: ${what}: ${wordsOf(e)}`);

const readState = async (def) => {
  try {
    return (await def.get()) ?? null;
  } catch (e) {
    warnSurface(`state ${def.name} get`, e);
    return null;
  }
};
// The window's context: { screen, states } for the agent's turn, and what the view published itself under `data`. A
// page with no state and no screen publishes its own data as it always did.
const surfaceDoc = async () => {
  if (surface.screen === null && surface.states.size === 0) return surface.own ?? null;
  const states = {};
  for (const def of surface.states.values()) {
    states[def.name] = { description: def.description, schema: def.schema, value: await readState(def), rules: def.rules };
  }
  const doc = { screen: surface.screen, states };
  if (surface.own !== undefined) doc.data = surface.own;
  return doc;
};
const publishSurface = async () => {
  const host = surface.host;
  if (host === null) return;
  try {
    await host.publish(await surfaceDoc());
  } catch (e) {
    warnSurface('context', e);
  }
};
// One publication for a burst: a registration, a set or a refresh goes out on the next tick, a change the form told of
// after SURFACE_DEBOUNCE_MS without another.
const scheduleSurface = (ms = 0) => {
  clearTimeout(surface.timer);
  surface.timer = setTimeout(publishSurface, ms);
};

// A patch has the state's fields, none of them required.
const patchSchema = (schema) => {
  const patch = { type: 'object', ...schema };
  delete patch.required;
  return patch;
};
const stateTool = (def) => ({
  name: `${def.name}_set`,
  description: describeTool(
    `Change «${def.name}»: ${def.description} Pass only the fields to change (a patch). Answers { ok, value, issues }: value is the state after the change, issues are everything to fix at once (level warn does not block; tell the person).`,
    def,
  ),
  inputSchema: patchSchema(def.schema),
});
const runState = (def) => async (patch) => {
  const issues = [];
  await gather(issues, () => def.set(patch ?? {}), 'form');
  const value = await readState(def);
  if (def.check) await gather(issues, () => def.check(value), 'rule', 'rule');
  scheduleSurface();
  return { ok: passed(issues), value, issues };
};
const actionTool = (def) => ({
  name: def.name,
  description: describeTool(
    `${def.description} Answers { ok, result, issues }: ok only when it is done; issues say what stopped it (source form, rule or server).`,
    def,
  ),
  inputSchema: def.schema ?? { type: 'object', properties: {} },
  confirm: def.confirm,
});
const runAction = (def) => async (args) => {
  const issues = [];
  if (def.check) await gather(issues, () => def.check(args ?? {}), 'rule', 'rule');
  // A rule that fails stops the action before it runs.
  if (!passed(issues)) return { ok: false, result: null, issues };
  const out = await gather(issues, () => def.exec(args ?? {}), 'server');
  scheduleSurface();
  if (!passed(issues)) return { ok: false, result: null, issues };
  // run answers its result, or { result, issues } when it has warnings to pass on.
  const carried = out !== null && typeof out === 'object' && Array.isArray(out.issues);
  return { ok: true, result: (carried ? out.result : out) ?? null, issues };
};

// A registration lives in the surface whether or not a host is there; attach offers its tool to the host.
const attach = (entry) => {
  if (surface.host === null || entry.tool === null) return;
  const handle = surface.host.register(entry.tool, entry.run);
  entry.detach = handle.unregister;
  handle.catch((e) => warnSurface(`tool ${entry.tool.name}`, e));
};
const detach = (entry) => {
  const off = entry.detach;
  entry.detach = null;
  if (off) Promise.resolve(off()).catch(() => {});
};
const entries = () => [...surface.states.values(), ...surface.actions.values()];
// connect() binds the surface to its host: what was registered before the handshake is offered now.
const bindSurface = (host) => {
  surface.host = host;
  for (const entry of entries()) attach(entry);
  if (surface.screen !== null || surface.states.size > 0) scheduleSurface();
};
const unbindSurface = (host) => {
  if (surface.host !== host) return;
  clearTimeout(surface.timer);
  surface.host = null;
  for (const entry of entries()) entry.detach = null;
};
const nameOf = (name, kind) => {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,58}$/.test(name))
    throw new HarnesslyError('invalid_params', `${kind}: a name of latin letters, digits, _ . - (59 at most)`);
  return name;
};
const put = (map, entry) => {
  const before = map.get(entry.name);
  if (before) remove(map, before);
  map.set(entry.name, entry);
  attach(entry);
  scheduleSurface();
};
const remove = (map, entry) => {
  if (map.get(entry.name) !== entry) return;
  map.delete(entry.name);
  entry.stop?.();
  detach(entry);
  scheduleSurface();
};

/**
 * A state of the page the agent reads and patches: the value goes into the window's context, and the tool `<name>_set`
 * takes a patch, calls set(patch), reads get() and answers { ok, value, issues }.
 */
function state(name, def) {
  if (!def || typeof def.get !== 'function' || typeof def.set !== 'function')
    throw new HarnesslyError('invalid_params', 'state(name, { description, schema, get, set })');
  const entry = {
    name: nameOf(name, 'state'),
    description: def.description ?? '',
    schema: def.schema ?? { type: 'object' },
    rules: def.rules ?? [],
    get: def.get,
    set: def.set,
    check: def.check,
    detach: null,
    stop: null,
  };
  entry.tool = stateTool(entry);
  entry.run = runState(entry);
  if (typeof def.subscribe === 'function') {
    const off = def.subscribe(() => scheduleSurface(SURFACE_DEBOUNCE_MS));
    // subscribe answers its own stop: a function, or a subscription with unsubscribe (RxJS).
    if (typeof off === 'function') entry.stop = off;
    else if (typeof off?.unsubscribe === 'function') entry.stop = () => off.unsubscribe();
  }
  put(surface.states, entry);
  return { unregister: () => remove(surface.states, entry), refresh: () => scheduleSurface() };
}

/**
 * An action of the screen the agent runs as a tool: { ok, result, issues }. One that changes data (mutates, the
 * default) asks the person first unless confirm: false.
 */
function action(name, def) {
  if (!def || typeof def.run !== 'function') throw new HarnesslyError('invalid_params', 'action(name, { description, schema, mutates, run })');
  const entry = {
    name: nameOf(name, 'action'),
    description: def.description ?? '',
    schema: def.schema,
    rules: def.rules ?? [],
    confirm: def.confirm ?? def.mutates !== false,
    exec: def.run,
    check: def.check,
    detach: null,
    stop: null,
  };
  entry.tool = actionTool(entry);
  entry.run = runAction(entry);
  put(surface.actions, entry);
  return { unregister: () => remove(surface.actions, entry) };
}

/** The screen the person is on: its title, route and a prompt for the agent. The last call stands. */
function screen(def) {
  const own = { title: String(def?.title ?? ''), route: String(def?.route ?? ''), prompt: String(def?.prompt ?? '') };
  surface.screen = own;
  scheduleSurface();
  return {
    clear: () => {
      if (surface.screen !== own) return;
      surface.screen = null;
      scheduleSurface();
    },
  };
}

async function connect(options = {}) {
  const parent = options.parent ?? window.parent;
  if (!parent || parent === window) throw new HarnesslyError('host_unavailable', 'the view is open outside Harnessly');

  const pending = new Map();
  const listeners = new Map();
  let hostOrigin = null;
  // The view's page tools (hl.tools.register) by name, and how a call of the agent runs one: the answer, or the error in
  // words, goes back to the host.
  let pageTools = new Map();
  // A call of the agent is a command with an id, and the host may send the same id again when it did not hear the
  // answer. The view runs an id once: a call that is running is not started again, and one that has been
  // answered gets the same answer again. The answers outlive a reload of the view where the browser lets it keep them.
  const ranCalls = recallRan();
  const runningCalls = new Set();
  const runPageTool = async (p) => {
    const id = p?.id;
    if (typeof id !== 'string') return;
    const ran = ranCalls.get(id);
    if (ran) {
      request('harnessly/tools.result', ran).catch(() => {});
      return;
    }
    if (runningCalls.has(id)) return;
    const tool = pageTools.get(p.name);
    if (!tool) {
      // Nothing ran, so nothing is remembered: the tool may be registered by the time the call comes again.
      request('harnessly/tools.result', { id, error: `the view offers no tool ${p.name}` }).catch(() => {});
      return;
    }
    runningCalls.add(id);
    let body;
    try {
      const result = await tool.run(p.arguments ?? {});
      body = { id, result: result === undefined ? null : result };
    } catch (e) {
      body = { id, error: e instanceof Error ? e.message : String(e) };
    }
    rememberRan(ranCalls, id, body);
    runningCalls.delete(id);
    request('harnessly/tools.result', body).catch(() => {});
  };
  // The agent's tool calls a view hears before they run (hooks.agent): every fn has its word; the first stop wins and the
  // contexts add up. A fn that throws or says nothing lets the call through.
  const hookFns = new Set();
  const runHook = async (p) => {
    const id = p?.id;
    if (typeof id !== 'string') return;
    let deny = null;
    const contexts = [];
    for (const fn of [...hookFns]) {
      try {
        const word = await fn({ tool: p.tool, input: p.input ?? {}, cut: p.cut === true });
        if (word?.decision === 'deny' && deny === null) deny = { decision: 'deny', reason: String(word.reason ?? '') };
        else if (typeof word?.context === 'string' && word.context !== '') contexts.push(word.context);
      } catch (e) {
        console.error(e);
      }
    }
    const body = deny ? { id, ...deny } : { id, context: contexts.join('\n') };
    request('harnessly/hooks.result', body).catch(() => {});
  };
  let seq = 0;

  const send = (message) => parent.postMessage({ jsonrpc: '2.0', ...message }, hostOrigin ?? '*');

  const emit = (event, payload) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    }
  };

  const request = (method, params, { timeout = TIMEOUT_MS } = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer =
        timeout > 0 ? setTimeout(() => (pending.delete(id), reject(new HarnesslyError('host_unavailable', `${method}: no answer`))), timeout) : 0;
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });

  const hl = { context: null };

  const applyTheme = (ctx) => {
    const root = document.documentElement;
    if (ctx.theme?.mode) {
      root.dataset.theme = ctx.theme.mode;
      root.style.colorScheme = ctx.theme.mode;
    }
    for (const [name, value] of Object.entries(ctx.theme?.tokens ?? {})) root.style.setProperty(name, value);
    if (ctx.locale) root.lang = ctx.locale;
  };

  // Host → view: only what the host window sent, and from the origin it answered the handshake with.
  const onMessage = (event) => {
    if (event.source !== parent) return;
    if (hostOrigin !== null && event.origin !== hostOrigin) return;
    const m = event.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.method === undefined) {
      // The first answer fixes the host's origin; every later message must come from it.
      hostOrigin ??= event.origin;
      const wait = pending.get(m.id);
      if (!wait) return;
      pending.delete(m.id);
      if (m.error) wait.reject(errorOf(m.error));
      else wait.resolve(m.result);
      return;
    }
    switch (m.method) {
      case 'ui/notifications/host-context-changed': {
        const before = hl.context;
        const next = ctxOf(m.params);
        hl.context = { ...before, ...next };
        applyTheme(hl.context);
        emit('context', hl.context);
        if (next.theme && JSON.stringify(next.theme) !== JSON.stringify(before?.theme)) emit('theme', hl.context.theme);
        break;
      }
      case 'ui/notifications/tool-result':
        emit('tool-result', m.params);
        break;
      case 'ui/notifications/tool-input':
        emit('tool-input', m.params);
        break;
      case 'harnessly/notifications/data':
      case 'harnessly/notifications/selection':
      case 'harnessly/notifications/storage':
      case 'harnessly/notifications/visibility':
      case 'harnessly/notifications/agents':
      case 'harnessly/notifications/event':
      case 'harnessly/notifications/files-changed':
      case 'harnessly/notifications/terminal-output':
      case 'harnessly/notifications/terminal-exit':
      case 'harnessly/notifications/key':
        emit(m.method.slice('harnessly/notifications/'.length), m.params);
        break;
      case 'harnessly/notifications/tool-call':
        void runPageTool(m.params);
        break;
      case 'harnessly/notifications/hook':
        void runHook(m.params);
        break;
      default:
        // A request the view does not know gets the standard answer, so the host does not wait.
        if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'method not found' } });
    }
  };
  window.addEventListener('message', onMessage);

  const protocol = HL_PROTOCOLS.includes(options.protocol) ? options.protocol : 1;
  const init = await request('ui/initialize', {
    protocolVersion: PROTOCOL,
    appInfo: { name: options.name ?? document.title ?? 'view', version: options.version ?? '0' },
    appCapabilities: {},
  }).catch((e) => {
    window.removeEventListener('message', onMessage);
    throw e;
  });
  hl.context = ctxOf(init.hostContext);
  hl.host = init.hostInfo;
  // What this view may call here, as the host said in the handshake; a host that did not say knows nothing new.
  const callable = new Set(init.hostCapabilities?.harnessly?.methods ?? []);
  hl.protocol = 1;
  /** Whether the host does a method here and the app holds its right: 'files.read', 'storage.user.get', 'harnessly/notify'. */
  hl.has = (name) => {
    if (typeof name !== 'string' || name === '') return false;
    const plain = name.replace(/^storage\.(install|user|chat|space|doc)\./, 'storage.');
    return callable.has(name) || callable.has(HAS_ALIAS[plain] ?? '') || callable.has(`harnessly/${plain}`);
  };
  /** Whether an answer is a refusal ({ error, code, message }): what protocol 2 answers instead of rejecting. */
  hl.refused = isRefusal;
  applyTheme(hl.context);
  notify('ui/notifications/initialized', {});
  // A view written for a newer protocol says so; the host answers the one it speaks with it (an older host, none: 1).
  if (protocol > 1 && callable.has('harnessly/protocol')) {
    hl.protocol = await request('harnessly/protocol', { protocol }).then((r) => (HL_PROTOCOLS.includes(r?.protocol) ? r.protocol : 1), () => 1);
  }
  debugSend = (line) => notify('harnessly/debug.log', line);
  for (const line of debugQueue.splice(0)) debugSend(line);

  hl.on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  };

  hl.chat = {
    // The chat shows the app's own name before the text; a view cannot choose another.
    send: (text) => request('ui/message', { role: 'user', content: [{ type: 'text', text }] }),
    read: ({ last = 20 } = {}) => request('harnessly/chat.read', { last }).then((r) => r.messages),
    card: (view, data) => request('harnessly/chat.card', { view, data }),
  };
  hl.agents = {
    list: () => request('harnessly/agents.list', {}).then((r) => r.agents),
    // A task in a new chat under this one (agents.run), within the app's budget of the day.
    run: (prompt, { title = '' } = {}) => request('harnessly/agents.run', { prompt, title }),
  };
  // One answer of a model, no tools (ai), within the app's budget of the day: { text, usd, spentToday, budget }.
  hl.ai = {
    complete: (prompt, { system = '', maxTokens = 0, model = '' } = {}) =>
      request('harnessly/ai.complete', { prompt, system, maxTokens, model }),
  };
  // A value into the safe, never read back (secrets.write): the app's own secret, or with shared the person's.
  hl.secrets = {
    put: (name, value, { shared = false } = {}) => request('harnessly/secrets.put', { name, value, shared }),
  };
  hl.pane = { open: (target) => request('harnessly/pane.open', { target }) };
  hl.tools = { call: (name, args = {}) => request('tools/call', { name, arguments: args }) };
  // Tools of the page (right tools.page): the agent of the chat lists them with page_tools and calls one with page_call;
  // the view runs it here, in the person's page, and the answer goes back. The host is told the whole list each time.
  const announce = () =>
    request('harnessly/tools.register', {
      tools: [...pageTools.values()].map(({ name, description, inputSchema, confirm }) => ({ name, description, inputSchema, confirm })),
    });
  hl.tools.register = (tool, run) => {
    if (!tool || typeof tool.name !== 'string' || typeof run !== 'function')
      return Promise.reject(new HarnesslyError('invalid_params', 'register({name, description, inputSchema}, run)'));
    // A tool that changes something asks the person first: confirm, or WebMCP's destructiveHint.
    const confirm = tool.confirm === true || tool.annotations?.destructiveHint === true;
    pageTools.set(tool.name, { name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, confirm, run });
    const ready = announce();
    const unregister = () => {
      if (pageTools.get(tool.name)?.run !== run) return Promise.resolve();
      pageTools.delete(tool.name);
      return announce();
    };
    return Object.assign(ready.then(() => ({ unregister })), { unregister });
  };
  // What the view shows, for the agent to read with page_tools (right context.publish): the last one stands.
  // Beside a state or a screen (hl.state, hl.screen) the view's own data goes under `data` of the same document.
  const publishRaw = (data) => request('harnessly/context.publish', { data }).then(() => undefined);
  hl.publish = async (data) => {
    surface.own = data;
    return publishRaw(await surfaceDoc());
  };
  // The standard WebMCP API: a view that registers its tools with navigator.modelContext offers them to the chat's agent
  // the same way. Where the browser has its own, a tool goes to both.
  const own = navigator.modelContext;
  const unregisters = new Map();
  const modelContext = {
    registerTool: (tool) => {
      const run = (args) => tool.execute(args ?? {}, { requestUserInteraction: (cb) => cb() });
      const handle = hl.tools.register(tool, run);
      unregisters.set(tool.name, handle.unregister);
      let native;
      try {
        native = own?.registerTool?.(tool);
      } catch {
        native = undefined;
      }
      return {
        unregister: () => {
          unregisters.delete(tool.name);
          native?.unregister?.();
          return handle.unregister();
        },
      };
    },
    unregisterTool: (name) => {
      unregisters.get(name)?.();
      unregisters.delete(name);
      try {
        own?.unregisterTool?.(name);
      } catch {
        // the browser's own may not know it
      }
    },
  };
  try {
    Object.defineProperty(navigator, 'modelContext', { value: modelContext, configurable: true });
  } catch {
    // a frozen navigator: hl.tools.register still works
  }
  // hl.flow and hl.data were never connected in the host (every call answered host_unavailable) and are gone. A view
  // that still calls them gets the reason, not a silent hang: use hl.storage (state) and hl.on('data') (a chat card).
  const removed = (name, instead) =>
    new Proxy(
      {},
      {
        get: (_, method) => () =>
          Promise.reject(new HarnesslyError('invalid_params', `hl.${name}.${String(method)} was removed from the SDK: ${instead}`)),
      },
    );
  hl.flow = removed('flow', 'keep the steps in hl.storage');
  hl.data = removed('data', 'keep the state in hl.storage, and read a card\'s data from hl.context.data');
  hl.storage = {};
  for (const scope of STORAGE_SCOPES) {
    hl.storage[scope] = {
      // get answers the value (null if none); getVersioned also the key's version, to hand back as set's ifVersion.
      get: (key) => request('harnessly/storage.get', { scope, key }).then((r) => r.value),
      getVersioned: (key) => request('harnessly/storage.get', { scope, key }).then((r) => ({ value: r.value, version: r.version })),
      // set answers the key's new version; with { ifVersion } it writes only if the key is still at that version,
      // else it rejects with code 'conflict' (error.version is the current one) and nothing is written.
      set: (key, value, options = {}) =>
        request('harnessly/storage.set', { scope, key, value, ...(options.ifVersion === undefined ? {} : { ifVersion: options.ifVersion }) }).then(
          (r) => r.version,
        ),
      delete: (key) => request('harnessly/storage.delete', { scope, key }).then(() => undefined),
      keys: () => request('harnessly/storage.keys', { scope }).then((r) => r.keys),
    };
  }
  // The values the person saved in the app's settings form (the manifest's `settings` schema), over its defaults. A
  // secret is not among them: the host fills it in on the machine, into the app's MCP servers, and nowhere else.
  hl.settings = {
    get: () => request('harnessly/settings.get', {}).then((r) => r.value),
  };  // The status of the view's document: the manifest's workflow, kept and checked by the host. get answers the
  // current version, its status, the moves this person may make and the journal; move makes one, of the version the
  // view saw (a document changed since is refused as conflict).
  hl.workflow = {
    get: () => request('harnessly/workflow.get', {}),
    move: (to, { version, hash, note } = {}) => request('harnessly/workflow.move', { to, version, hash, note }),
  };

  // Files of the chat's workspace, inside the masks of files.read:<mask> and files.write:<mask>. A path is relative to
  // the workspace; a text moves, up to 4 MB.
  let watchers = 0;
  hl.files = {
    read: (path) => request('harnessly/files.read', { path }).then((r) => r.text),
    write: (path, text) => request('harnessly/files.write', { path, text }).then(() => undefined),
    // A folder's files and folders that the masks reach ('' is the chat's folder).
    list: (folder = '') => request('harnessly/files.list', { path: folder }).then((r) => r.entries),
    // Lines holding a text, or with a glob alone the files by name: { hits: [{ path, line, text }], cut }.
    search: (text, { glob = '', case: matchCase = false, limit = 0 } = {}) =>
      request('harnessly/files.search', { text, glob, case: matchCase, limit }),
    // onChange(paths) hears which files under the masks changed; the promise gives the function that stops it.
    watch: async (onChange) => {
      if (watchers === 0) await request('harnessly/files.watch', {});
      watchers++;
      const off = hl.on('files-changed', (p) => onChange(p?.paths ?? []));
      let stopped = false;
      return () => {
        if (stopped) return Promise.resolve();
        stopped = true;
        off();
        watchers--;
        return watchers === 0 ? request('harnessly/files.unwatch', {}).then(() => undefined) : Promise.resolve();
      };
    },
    // The person picks a file in the host's dialog: { path, text }, or null when they close it.
    pick: ({ accept = [] } = {}) => request('harnessly/files.pick', { accept }).then((r) => r.file ?? null),
    // A file the person gave the view (a File or Blob: from hl.files.choose, a drop, the view's own <input>) into the
    // chat's workspace at path, inside the app's write masks: { path, size }.
    upload: async (file, path) => {
      const name = typeof file?.name === 'string' ? file.name : 'file';
      return request('harnessly/files.upload', { path: path || 'uploads/' + name, data: await base64Of(file) });
    },
    // Asks the person for files from their computer: call it from a click. Answers the Files ([] when they cancel).
    choose: ({ accept = [], multiple = false } = {}) =>
      new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = multiple;
        if (accept.length) input.accept = accept.join(',');
        input.style.display = 'none';
        const done = () => {
          resolve([...(input.files ?? [])]);
          input.remove();
        };
        input.addEventListener('change', done, { once: true });
        input.addEventListener('cancel', done, { once: true });
        document.body.append(input);
        input.click();
      }),
    // Makes an element take files dropped on it: onFiles gets the Files; the element has data-drop="over" while files
    // are over it. Answers the function that stops it.
    dropZone: (el, onFiles) => {
      const over = (e) => {
        if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
        e.preventDefault();
        el.dataset.drop = 'over';
      };
      const leave = () => delete el.dataset.drop;
      const drop = (e) => {
        e.preventDefault();
        leave();
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length) onFiles(files);
      };
      el.addEventListener('dragover', over);
      el.addEventListener('dragleave', leave);
      el.addEventListener('drop', drop);
      return () => {
        el.removeEventListener('dragover', over);
        el.removeEventListener('dragleave', leave);
        el.removeEventListener('drop', drop);
        leave();
      };
    },
  };
  // The repository of the chat's folder, read only (git.read).
  hl.git = {
    status: () => request('harnessly/git.status', {}),
    diff: ({ path = '', staged = false, ref = '' } = {}) => request('harnessly/git.diff', { path, staged, ref }),
    log: ({ limit = 0, path = '' } = {}) => request('harnessly/git.log', { limit, path }).then((r) => r.commits),
  };
  // Commands in the chat's folder, inside the agent's sandbox (terminal.run): { code, output, cut, timedOut, ms }. The
  // timeout is in seconds.
  hl.terminal = {
    run: (command, { cwd = '', timeout = 0 } = {}) => request('harnessly/terminal.run', { command, cwd, timeout }),
    // A shell on a terminal of its own in the chat's folder (terminal.pty): write what is typed, hear what it prints
    // (bytes, for a terminal emulator such as xterm) and how it ends.
    open: async ({ cols = 80, rows = 24, cwd = '' } = {}) => {
      const { id } = await request('harnessly/terminal.open', { cols, rows, cwd });
      const data = new Set();
      const exits = new Set();
      const offData = hl.on('terminal-output', (p) => {
        if (p?.id === id) for (const fn of data) fn(p.data);
      });
      const offExit = hl.on('terminal-exit', (p) => {
        if (p?.id !== id) return;
        offData();
        offExit();
        for (const fn of exits) fn(p.code ?? null);
      });
      const hear = (set) => (fn) => {
        set.add(fn);
        return () => set.delete(fn);
      };
      const term = {
        id,
        write: (text) => request('harnessly/terminal.write', { id, data: text }).then(() => undefined),
        resize: (c, r) => request('harnessly/terminal.resize', { id, cols: c, rows: r }).then(() => undefined),
        close: () => request('harnessly/terminal.close', { id }).then(() => undefined),
        onData: hear(data),
        onExit: hear(exits),
      };
      // The terminal's methods answer refusals as the rest of hl does in protocol 2.
      if (hl.protocol >= 2) answerRefusals(term, false);
      return term;
    },
    // What the chat's terminals show, as text (terminal.read): [{ id, text }]; "agent" is the agent's own.
    read: ({ terminal = '', lines = 0 } = {}) =>
      request('harnessly/terminal.read', { terminal, lines }).then((r) => r.terminals),
  };
  // The agent's tool calls before they run (hooks.agent): fn({ tool, input }) answers { decision: 'deny', reason } to stop
  // the call, { context } to add a line for the agent, or nothing. The promise gives the function that stops hearing.
  hl.hooks = {
    on: async (kind, fn) => {
      if (kind !== 'tool') throw Object.assign(new Error(`no hook ${kind}: only 'tool'`), { code: 'invalid_params' });
      hookFns.add(fn);
      if (hookFns.size === 1) await request('harnessly/hooks.subscribe', {});
      return () => hookFns.delete(fn);
    },
  };
  // The agent's browser of the chat: look (browser.read: tabs, snapshot, screenshot, wait_for) and act (browser.drive:
  // open, navigate, close_tab, resize, click, hover, type, press_key, select, dialog), with the chrome_* tools' arguments.
  hl.browser = {
    read: (tool, args = {}) => request('harnessly/browser.read', { tool, args }),
    drive: (tool, args = {}) => request('harnessly/browser.drive', { tool, args }),
  };
  // Long commands (process): a dev server, a watcher. They run until stopped or until the app is off in the chat.
  hl.process = {
    start: (command, { cwd = '' } = {}) => request('harnessly/process.start', { command, cwd }),
    stop: (id) => request('harnessly/process.stop', { id }),
    list: () => request('harnessly/process.list', {}).then((r) => r.processes),
    output: (id, { since = 0 } = {}) => request('harnessly/process.output', { id, since }),
  };
  // A local port in the right pane's browser (process).
  hl.preview = {
    open: (port, { path = '/' } = {}) => request('harnessly/preview.open', { port, path }).then(() => undefined),
  };
  // The chat's events, by kind (turn, tool, message), for the kinds the app holds events:<kind> for. The promise gives
  // the function that stops hearing.
  hl.events = {
    on: async (kind, fn) => {
      await request('harnessly/events.subscribe', { kinds: [kind] });
      return hl.on('event', (e) => {
        if (e?.kind === kind) fn(e);
      });
    },
  };
  hl.ui = {
    // A tone (info, success, warning, error) and a second line are optional; an older host shows the words alone.
    toast: (text, { tone, description } = {}) =>
      request('harnessly/ui.toast', { text, ...(tone ? { tone } : {}), ...(description ? { description } : {}) }).then(() => undefined),
    // A person decides in their own time.
    confirm: (text) => request('harnessly/ui.confirm', { text }, { timeout: 0 }).then((r) => r.ok),
  };
  // The host's shortcut commands of a screen (deck, video, site, pictures, files), on the keys the person set for them:
  // the view runs them while it is up. A press inside the view's own frame is the view's; hl.keys.press passes
  // one on to the host, which runs it only while the frame has the focus.
  const keyScopes = new Map();
  hl.keys = {
    on: (scope, handlers) => {
      keyScopes.get(scope)?.();
      const off = hl.on('key', (p) => {
        if (typeof p?.command === 'string' && p.command.startsWith(`${scope}.`)) handlers[p.command]?.(p.chord);
      });
      const stop = () => {
        if (keyScopes.get(scope) !== stop) return Promise.resolve();
        keyScopes.delete(scope);
        off();
        return request('harnessly/keys.off', { scope }).then(() => undefined);
      };
      keyScopes.set(scope, stop);
      const ready = request('harnessly/keys.on', { scope, commands: Object.keys(handlers) });
      return Object.assign(stop, { ready: ready.then(() => undefined) });
    },
    press: (chord, { typing = false } = {}) => request('harnessly/keys.press', { chord, typing }).then((r) => r.ran === true),
    hints: (commands) => request('harnessly/keys.hints', { commands }).then((r) => r.hints),
  };
  // An onboarding step tells the host it is finished; other slots ignore it.
  hl.slot = { done: () => request('harnessly/slot.done', {}).then(() => undefined) };
  // The Document API of Sinopia, for a view shown beside a document (target sinopia.<kind>): the host and the runtime
  // check the manifest's rights (sinopia.read/write/comment/export) on every call.
  const sinopia = (method, params = {}) => request(`harnessly/sinopia.${method}`, params).then((r) => r.result);
  hl.sinopia = {
    document: () => sinopia('document'),
    selection: () => sinopia('selection'),
    node: (id) => sinopia('node', { id }),
    query: (selector, options = {}) => sinopia('query', { selector, ...options }),
    patch: (ops) => sinopia('patch', { ops }),
    fields: () => sinopia('fields'),
    setFields: (patch) => sinopia('setFields', { patch }),
    mark: (nodes, options = {}) => sinopia('mark', { nodes, ...options }),
    comment: (node, text) => sinopia('comment', { node, text }),
    render: (options = {}) => sinopia('render', options),
    boards: { add: (options) => sinopia('boards.add', options) },
  };
  hl.notify = (text) => request('harnessly/notify', { text }).then(() => undefined);
  /** The smart notice's slot: ask the person (choice, confirm, field, code, custom) or show a status or progress.
   *  Never a password, a key or a sign-in: refused (the safe and the site sign-in are for those). */
  hl.notice = {
    ask: (spec) => request('harnessly/notice.ask', spec),
    show: (spec) => request('harnessly/notice.show', spec),
    update: (id, change = {}) => request('harnessly/notice.update', { id, ...change }).then(() => undefined),
    close: (id) => request('harnessly/notice.close', { id }).then(() => undefined),
  };
  /** Tells the host the content's height (a card in the feed is as tall as its view asks). */
  hl.resize = (height) => notify('ui/notifications/size-changed', { height: Math.ceil(height) });
  // The page's states, actions and screen: the module's own (see above), offered through this connection from now on.
  const surfaceHost = { register: hl.tools.register, publish: publishRaw };
  hl.state = state;
  hl.action = action;
  hl.screen = screen;
  bindSurface(surfaceHost);
  hl.close = () => {
    unbindSurface(surfaceHost);
    window.removeEventListener('message', onMessage);
  };

  // A card and a slot view are as tall as their content.
  if (['chat', 'settings', 'onboarding', 'object-action'].includes(hl.context?.target) && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => hl.resize(document.documentElement.scrollHeight)).observe(document.documentElement);
  }
  if (hl.protocol >= 2) answerRefusals(hl, true);
  return hl;
}

globalThis.harnessly = { connect: connect, HarnesslyError: HarnesslyError, state: state, action: action, screen: screen };
})();
