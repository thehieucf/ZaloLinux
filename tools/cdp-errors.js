// Attach to a running Zalo (started with ZALO_DEBUG_PORT) over the DevTools
// protocol and print every uncaught exception / rejected promise / console
// error from all pages and workers, with stack traces.
//
// usage: node tools/cdp-errors.js [port]
const port = process.argv[2] || 9222;
const attached = new Set();

function frames(st) {
  if (!st || !st.callFrames) return '';
  return st.callFrames.slice(0, 8)
    .map(f => `      at ${f.functionName || '<anon>'} ${f.url.split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`)
    .join('\n');
}

function attach(t) {
  if (attached.has(t.id) || !t.webSocketDebuggerUrl) return;
  attached.add(t.id);
  const name = `${t.type}:${(t.title || t.url).split('/').pop().slice(0, 40)}`;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
  ws.onopen = () => {
    send('Runtime.enable');
    // Pause-free: only ask for async stacks so promise rejections are traceable.
    send('Debugger.enable');
    send('Debugger.setAsyncCallStackDepth', { maxDepth: 8 });
    console.log(`[attached] ${name}`);
  };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      console.log(`\n[${new Date().toISOString().slice(11, 23)}] ${name} EXCEPTION ${desc}\n${frames(d.stackTrace)}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      const text = m.params.args.map(a => a.description || a.value).join(' ');
      console.log(`\n[${new Date().toISOString().slice(11, 23)}] ${name} console.error ${String(text).slice(0, 600)}\n${frames(m.params.stackTrace)}`);
    }
  };
  ws.onclose = () => attached.delete(t.id);
}

async function poll() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    list.forEach(attach);
  } catch (e) {
    console.log(`[cdp] ${e.message}`);
  }
}

poll();
setInterval(poll, 2000);
