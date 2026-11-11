// The first script of every page the view server serves (/__hl/bridge-shim.js; a file, so the CSP stays script-src 'self').
// A view written the standard MCP Apps way posts to window.parent and listens to `message` on window; it knows no nonce
// and no MessageChannel. This shim carries both for it:
//
//   1. It sends ui/initialize with the page's nonce (<meta name="hl-nonce">, written by the view server) to the host
//      window. Only a document that presents the nonce is answered, and the answer carries one end of a MessageChannel.
//   2. From then on the host talks on that port only. The shim replaces window.parent (it is [Replaceable]) with a
//      stand-in whose postMessage sends on the port, and re-dispatches every message of the port as a `message` event on
//      window with the host's origin and the stand-in as its source.
//   3. The view's own ui/initialize is answered from the host's reply of step 1; everything the view posts before the
//      port is up waits in a queue.
//
// A document the frame navigated to has no nonce (or the host has closed its port), so it never gets a port.
(function () {
  'use strict';
  var realParent = window.parent;
  if (!realParent || realParent === window) return;

  // What breaks before app-sdk.js loads is told to the host here (the SDK reports only once it is up): a script or style
  // that did not load, an exception, a rejected promise, a blocked request. The host puts it in the view's journal and,
  // while the view has not connected, in the words of its «не запустилось» card. A few, short, and never the page's data.
  var told = 0;
  var tell = function (kind, text, src) {
    if (told >= 20) return;
    told += 1;
    try {
      realParent.postMessage(
        { hlViewError: { kind: kind, text: String(text).slice(0, 500), src: src ? String(src).slice(0, 500) : '' } },
        '*',
      );
    } catch (e) {
      // a host that cannot be told stays untold
    }
  };
  window.addEventListener(
    'error',
    function (e) {
      var t = e.target;
      if (t && t !== window && (t.src || t.href)) tell('resource', 'did not load', t.src || t.href);
      else tell('error', (e.message || 'error') + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : ''), e.filename);
    },
    true,
  );
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    tell('error', 'unhandled: ' + (r && r.message ? r.message : String(r)));
  });
  window.addEventListener('securitypolicyviolation', function (e) {
    tell('csp', 'CSP blocked ' + (e.blockedURI || 'inline') + ' by ' + e.violatedDirective, e.blockedURI);
  });

  var meta = document.querySelector('meta[name="hl-nonce"]');
  var nonce = meta ? meta.getAttribute('content') || '' : '';
  // A view the app's own server hosts (delivery mode remote) gets the nonce in the address's fragment, which never reaches
  // that server; it is taken out of the address at once, so the page's own scripts and a reload do not see it.
  if (!nonce) {
    var found = /(?:^#|&)hl-nonce=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (found) {
      nonce = found[1];
      var rest = location.hash.replace(/(?:^#|&)hl-nonce=[A-Za-z0-9_-]+/, '').replace(/^&/, '');
      try {
        history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : ''));
      } catch (e) {
        // an address the page cannot rewrite: the nonce stays in it
      }
    }
  }
  var PREFIX = 'hl-shim-';
  var RETRY_MS = 250;
  var GIVE_UP_MS = 15000;

  var port = null;
  var hostOrigin = null;
  var hostReply = null;
  var failure = null;
  var queue = [];
  var attempt = 0;
  var timer = 0;
  var started = Date.now();

  var shimParent = {
    postMessage: function (message) {
      send(message);
    },
  };

  // To the view: a message event the way the host's window would have made it.
  var deliver = function (data) {
    var event = new MessageEvent('message', { data: data, origin: hostOrigin || '' });
    // `source` only takes a window or a port in the constructor; an own property is what the view reads.
    Object.defineProperty(event, 'source', { value: shimParent });
    window.dispatchEvent(event);
  };

  var isRequest = function (m) {
    return m && typeof m === 'object' && m.id !== undefined && typeof m.method === 'string';
  };

  var answer = function (m) {
    if (failure) {
      if (isRequest(m)) deliver({ jsonrpc: '2.0', id: m.id, error: failure });
      return;
    }
    if (m && m.method === 'ui/initialize' && m.id !== undefined) {
      // The host has been told already (with the nonce); the view gets the same answer.
      setTimeout(function () {
        deliver({ jsonrpc: '2.0', id: m.id, result: hostReply });
      }, 0);
      return;
    }
    port.postMessage(m);
  };

  var send = function (m) {
    if (port === null && failure === null) queue.push(m);
    else answer(m);
  };

  var flush = function () {
    var waiting = queue;
    queue = [];
    waiting.forEach(answer);
  };

  var onReply = function (event) {
    if (port !== null || event.source !== realParent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== '2.0' || typeof m.id !== 'string' || m.id.indexOf(PREFIX) !== 0 || m.method !== undefined) return;
    if (m.error) {
      // The host refused this document: nothing will come, and what the view asked is answered with the refusal.
      failure = m.error;
      stop();
      flush();
      return;
    }
    var handed = event.ports && event.ports[0];
    if (!handed) return;
    port = handed;
    hostOrigin = event.origin;
    hostReply = m.result;
    port.onmessage = function (e) {
      deliver(e.data);
    };
    if (typeof port.start === 'function') port.start();
    stop();
    flush();
  };

  var stop = function () {
    clearInterval(timer);
    window.removeEventListener('message', onReply);
  };

  var hello = function () {
    if (Date.now() - started > GIVE_UP_MS) {
      failure = { code: -32000, message: 'the host did not answer', data: { code: 'host_unavailable' } };
      stop();
      flush();
      return;
    }
    attempt += 1;
    realParent.postMessage(
      {
        jsonrpc: '2.0',
        id: PREFIX + attempt,
        method: 'ui/initialize',
        params: {
          protocolVersion: '2025-11-21',
          appInfo: { name: document.title || 'view', version: '0' },
          appCapabilities: {},
          nonce: nonce,
        },
      },
      '*',
    );
  };

  window.addEventListener('message', onReply);
  try {
    window.parent = shimParent;
  } catch (e) {
    // A browser that will not let the view's parent be replaced cannot carry a standard view; the view gets no host.
    failure = { code: -32000, message: 'window.parent is fixed', data: { code: 'host_unavailable' } };
    stop();
    return;
  }
  // The host's bridge may not be listening yet when the page starts: ask again until it answers.
  hello();
  timer = setInterval(hello, RETRY_MS);
})();
