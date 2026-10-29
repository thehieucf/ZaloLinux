// Evaluate an expression inside a running Zalo page over the DevTools protocol.
// Inside the expression, `wr` is webpack's require (module cache: wr.c).
//
// usage: node tools/cdp-eval.js '<expression>' [titleSubstring=Zalo] [port=9222]
const [expr, titleSub = 'Zalo', port = 9222] = process.argv.slice(2);

const prelude = `(() => {
  if (!window.__wr) (window.webpackJsonp = window.webpackJsonp || [])
    .push([[987654], { __zl_wr: (m, e, r) => { window.__wr = r; } }, [['__zl_wr']]]);
  return window.__wr;
})()`;

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find(x => x.type === 'page' && x.title === titleSub) || list.find(x => (x.title + x.url).includes(titleSub));
  if (!t) throw new Error(`no target matching ${titleSub}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  const expression = `(async () => { const wr = ${prelude}; return await (${expr}); })()`;
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id !== 1) return;
    const r = m.result;
    if (r.exceptionDetails) console.log('EXCEPTION', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
    ws.close();
  };
})().catch(e => { console.error(e.message); process.exit(1); });
