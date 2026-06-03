/** Self-contained HTML for the local request inspector (no external assets). */
export const INSPECTOR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>KProxy Inspector</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; display: flex; height: 100vh; }
  header { position: fixed; top: 0; left: 0; right: 0; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: #111; color: #eee; z-index: 10; }
  header b { color: #4ade80; }
  #wrap { display: flex; width: 100%; padding-top: 40px; }
  #list { width: 42%; overflow: auto; border-right: 1px solid #8884; }
  #detail { flex: 1; overflow: auto; padding: 12px; }
  .row { display: flex; gap: 8px; padding: 6px 12px; cursor: pointer; border-bottom: 1px solid #8882; }
  .row:hover { background: #8881; }
  .row.sel { background: #2563eb22; }
  .m { font-weight: 700; width: 52px; }
  .s2 { color: #22c55e; } .s3 { color: #eab308; } .s4, .s5 { color: #ef4444; }
  .p { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t { color: #888; }
  pre { white-space: pre-wrap; word-break: break-all; background: #8881; padding: 8px; border-radius: 6px; }
  h3 { margin: 14px 0 4px; } button { font: inherit; padding: 4px 10px; cursor: pointer; }
  .empty { color: #888; padding: 24px; }
</style>
</head>
<body>
<header><b>KProxy</b> Inspector <span id="count" class="t"></span></header>
<div id="wrap">
  <div id="list"><div class="empty">Waiting for requests…</div></div>
  <div id="detail"><div class="empty">Select a request</div></div>
</div>
<script>
const list = document.getElementById('list');
const detail = document.getElementById('detail');
const count = document.getElementById('count');
let items = [];
let selected = null;

function cls(s){ return 's' + String(s)[0]; }
function b64(s){ try { return atob(s); } catch { return '[binary]'; } }

function render(){
  count.textContent = items.length ? '(' + items.length + ')' : '';
  if (!items.length){ list.innerHTML = '<div class="empty">Waiting for requests…</div>'; return; }
  list.innerHTML = '';
  for (const c of items){
    const row = document.createElement('div');
    row.className = 'row' + (selected === c.id ? ' sel' : '');
    row.innerHTML = '<span class="m">'+c.method+'</span>'
      + '<span class="'+cls(c.status)+'">'+c.status+'</span>'
      + '<span class="p">'+c.path+'</span>'
      + '<span class="t">'+c.durationMs+'ms</span>';
    row.onclick = () => { selected = c.id; render(); showDetail(c); };
    list.appendChild(row);
  }
}

function headers(h){ return Object.entries(h||{}).map(([k,v]) => k+': '+v).join('\\n') || '(none)'; }

function showDetail(c){
  detail.innerHTML =
    '<h2>'+c.method+' '+c.path+' → '+c.status+'</h2>'
    + '<button id="replay">↻ Replay</button> <span class="t">'+new Date(c.time).toLocaleTimeString()+' · '+c.durationMs+'ms</span>'
    + '<h3>Request headers</h3><pre>'+headers(c.reqHeaders)+'</pre>'
    + (c.reqBodyB64 ? '<h3>Request body</h3><pre>'+escapeHtml(b64(c.reqBodyB64))+'</pre>' : '')
    + '<h3>Response headers</h3><pre>'+headers(c.resHeaders)+'</pre>'
    + (c.resBodyB64 ? '<h3>Response body</h3><pre>'+escapeHtml(b64(c.resBodyB64))+'</pre>' : '');
  const rb = document.getElementById('replay');
  if (rb) rb.onclick = async () => {
    rb.textContent = 'Replaying…';
    try { const r = await fetch('/replay/'+c.id, {method:'POST'}); const j = await r.json();
      rb.textContent = '↻ Replay (→ '+ (j.status ?? 'err') +')'; } catch { rb.textContent = '↻ Replay (failed)'; }
  };
}

function escapeHtml(s){ return s.replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch])); }

async function load(){ const r = await fetch('/captures'); items = await r.json(); render(); }
load();
const es = new EventSource('/stream');
es.onmessage = (e) => { const c = JSON.parse(e.data); items.unshift(c); if (items.length > 300) items.pop(); render(); };
</script>
</body>
</html>`;
