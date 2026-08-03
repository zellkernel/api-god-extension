// content.js — isolated world. Receives teed GraphQL bodies from inject.js,
// parses X's timeline JSON into flat records (ported from api-god-x / xsearch.py),
// dedupes by tweet id, and exports the running set as JSONL or markdown.
(() => {
  'use strict';
  if (window.__apiGodContent) return;
  window.__apiGodContent = true;

  // ---------- parser (ported from xsearch.py) ----------
  function rec(o) {
    return {
      id: o.id, handle: o.handle, name: o.name, text: o.text, time: o.time, url: o.url,
      likes: o.likes || 0, replies: o.replies || 0, reposts: o.reposts || 0,
      followers: o.followers || 0, blue: !!o.blue, verified: !!o.verified,
      views: o.views || 0, quotes: o.quotes || 0, lang: o.lang || '', is_retweet: !!o.is_retweet,
      source: [o.source || 'session'],
    };
  }
  function parseTweet(itemContent) {
    try {
      let result = itemContent.tweet_results && itemContent.tweet_results.result;
      if (!result) return null;
      if (result.__typename === 'TweetWithVisibilityResults') result = result.tweet || result;
      const legacy = result.legacy || {};
      const ur = (((result.core || {}).user_results || {}).result) || {};
      const uLegacy = ur.legacy || {};
      const uCore = ur.core || {};
      const tid = legacy.id_str || result.rest_id || '';
      const screen = uCore.screen_name || uLegacy.screen_name || '';
      if (!tid || !screen) return null;
      return rec({
        id: tid, handle: '@' + screen, name: uCore.name || uLegacy.name || '',
        text: (legacy.full_text || legacy.text || '').replace(/\n/g, ' '),
        time: legacy.created_at || '', url: `https://x.com/${screen}/status/${tid}`,
        likes: legacy.favorite_count || 0, replies: legacy.reply_count || 0,
        reposts: legacy.retweet_count || 0, source: 'session',
        followers: uLegacy.followers_count || 0,
        blue: ur.is_blue_verified || false, verified: uLegacy.verified || false,
        views: parseInt(((result.views || {}) || {}).count || 0, 10) || 0,
        quotes: legacy.quote_count || 0, lang: legacy.lang || '',
        is_retweet: 'retweeted_status_result' in legacy,
      });
    } catch (_) { return null; }
  }
  // Walk a list of `instructions` -> records. Shared by every timeline shape.
  function walkInstructions(insList, out) {
    if (!Array.isArray(insList)) return;
    for (const ins of insList) {
      if (ins.type !== 'TimelineAddEntries') continue;
      for (const entry of ins.entries || []) {
        const content = entry.content || {};
        if (content.entryType === 'TimelineTimelineCursor') continue;
        const ic = content.itemContent || {};
        if (ic.itemType === 'TimelineTweet') { const r = parseTweet(ic); if (r) out.push(r); }
        for (const item of content.items || []) {
          const ic2 = ((item.item || {}).itemContent) || {};
          if (ic2.itemType === 'TimelineTweet') { const r = parseTweet(ic2); if (r) out.push(r); }
        }
      }
    }
  }
  function dig(root, path) {
    let node = root;
    for (const k of path) node = (node && typeof node === 'object') ? node[k] : undefined;
    return node;
  }
  // Op-specific instruction locations (search / user / list), same as xsearch.py.
  function extractKnown(data, out) {
    const d = data.data || {};
    const search = dig(d, ['search_by_raw_query', 'search_timeline', 'timeline', 'instructions']);
    if (search) walkInstructions(search, out);
    for (const p of [['user', 'result', 'timeline_v2', 'timeline', 'instructions'],
                     ['user', 'result', 'timeline', 'timeline', 'instructions']]) {
      const ins = dig(d, p); if (ins) { walkInstructions(ins, out); break; }
    }
    for (const p of [['list', 'tweets_timeline', 'timeline', 'instructions'],
                     ['list', 'timeline_response', 'timeline', 'timeline', 'instructions']]) {
      const ins = dig(d, p); if (ins) { walkInstructions(ins, out); break; }
    }
    // TweetResultsByRestIds: flat array
    const batch = dig(d, ['tweetResult']);
    if (Array.isArray(batch)) for (const e of batch) { const r = parseTweet({ tweet_results: e }); if (r) { r.source = ['batch']; out.push(r); } }
  }
  // Generic fallback: any op (HomeTimeline, TweetDetail, Bookmarks, future renames)
  // — find every `instructions` array and every stray `tweet_results` in the tree.
  function extractGeneric(data, out) {
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 40) return;
      if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
      if (Array.isArray(o.instructions)) walkInstructions(o.instructions, out);
      if (o.tweet_results && o.tweet_results.result) { const r = parseTweet(o); if (r) out.push(r); }
      for (const k in o) {
        if (k === 'instructions' || k === 'tweet_results') continue;
        const v = o[k];
        if (v && typeof v === 'object' && !seen.has(v)) { seen.add(v); walk(v, depth + 1); }
      }
    })(data, 0);
  }

  // Node-only export so the parity test drives the SHIPPED parser, not a copy.
  // (No `module` in the browser content-script world, so this is a no-op there.)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseTweet, walkInstructions, extractKnown, extractGeneric };
    return;
  }

  // ---------- aggregation ----------
  const tweets = new Map(); // id -> record
  let captures = 0;
  function ingest(data) {
    const out = [];
    extractKnown(data, out);
    if (!out.length) extractGeneric(data, out);
    let added = 0;
    for (const r of out) {
      if (!tweets.has(r.id)) { tweets.set(r.id, r); added++; }
    }
    if (added) render();
    return added;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.type !== 'APIGOD_CAPTURE' || !d.json) return;
    captures++;
    try { ingest(d.json); } catch (_) {}
  });

  // ---------- export ----------
  function records() { return [...tweets.values()]; }
  function toJSONL() { return records().map((r) => JSON.stringify(r)).join('\n') + '\n'; }
  function toMarkdown() {
    const rs = records();
    const head = `# X export — ${rs.length} posts\n\n*pulled ${new Date().toISOString().slice(0, 10)} from ${location.href}*\n\n---\n\n`;
    return head + rs.map((r) =>
      `**${r.handle}** ${r.name ? '('+r.name+')' : ''} · ${r.time}\n\n` +
      `${r.text}\n\n` +
      `[${r.url}](${r.url}) · ♥ ${r.likes.toLocaleString()} · ↺ ${r.reposts.toLocaleString()} · 💬 ${r.replies.toLocaleString()}` +
      (r.views ? ` · 👁 ${r.views.toLocaleString()}` : '')
    ).join('\n\n---\n\n') + '\n';
  }
  function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCSV() {
    const cols = ['id','handle','name','text','time','url','likes','replies','reposts','followers','blue','verified','views','quotes','lang','is_retweet','source'];
    return cols.join(',') + '\n' +
      records().map((r) => cols.map((c) => csvCell(Array.isArray(r[c]) ? r[c].join('|') : r[c])).join(',')).join('\n') + '\n';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function slugContext() {
    const p = location.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'home';
    const q = new URLSearchParams(location.search).get('q');
    return (q ? 'search-' + q : p).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }
  function download(text, ext) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `x-${slugContext()}.${ext}`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------- UI ----------
  let panel = null;
  let autoTimer = null, autoLastSize = 0, autoIdle = 0, autoDeadline = 0, autoMins = '';
  function status(msg) { const s = panel && panel.querySelector('#ag-stat'); if (s) s.textContent = msg; }
  function updateAutoBtn(on) {
    const b = panel && panel.querySelector('#ag-auto'); if (!b) return;
    b.textContent = 'Autoscroll: ' + (on ? 'ON' : 'OFF');
    b.style.background = on ? '#00ba7c' : '#38444d';
  }
  function fmtLeft() {
    const s = Math.max(0, Math.round((autoDeadline - Date.now()) / 1000));
    return s >= 60 ? Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's' : s + 's';
  }
  // Autoscroll assists pagination: X only fetches the next page once you reach the bottom,
  // so each tick jumps straight to the bottom to trip its loader — fast, like holding Page
  // Down. The extension itself still fetches nothing. OFF by default; stops on whichever
  // comes first: the timer you set (blank = none) or an idle stretch with no new posts.
  const AUTO_MS = 350, AUTO_IDLE_MAX = 24;   // ~3 ticks/sec; ~8s of no growth = stop
  function autoTick() {
    const el = document.scrollingElement || document.documentElement;
    window.scrollTo(0, el.scrollHeight);     // slam to the bottom → triggers X's loader
    if (tweets.size > autoLastSize) { autoLastSize = tweets.size; autoIdle = 0; }
    else if (++autoIdle >= AUTO_IDLE_MAX) { return stopAuto('autoscroll stopped — no new posts'); }
    if (autoDeadline && Date.now() >= autoDeadline) { return stopAuto('autoscroll stopped — timer done'); }
    if (autoDeadline) status(`autoscroll · ${fmtLeft()} left · ${tweets.size} posts`);
  }
  function startAuto() {
    if (autoTimer) return;
    autoLastSize = tweets.size; autoIdle = 0;
    const mins = parseFloat(autoMins);
    autoDeadline = (mins > 0) ? Date.now() + mins * 60000 : 0;
    autoTick();                              // fire immediately, no initial delay
    autoTimer = setInterval(autoTick, AUTO_MS);
    updateAutoBtn(true);
    status(autoDeadline ? `autoscroll · ${fmtLeft()} left` : 'autoscroll on — capturing');
  }
  function stopAuto(msg) {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    autoDeadline = 0;
    updateAutoBtn(false); if (msg) status(msg);
  }
  function renderPreview() {
    const pv = panel && panel.querySelector('#ag-preview');
    if (!pv || pv.style.display === 'none') return;
    const rs = records().slice(-15).reverse();
    pv.innerHTML = rs.length
      ? rs.map((r) =>
          '<div style="padding:4px 0;border-top:1px solid #22303c">' +
          '<b>' + esc(r.handle) + '</b> ' +
          '<span style="color:#8899a6">' + (r.likes || 0).toLocaleString() + '♥</span><br>' +
          '<span style="color:#c9d3da">' + esc(r.text).slice(0, 100) + '</span></div>'
        ).join('')
      : '<div style="color:#8899a6;padding:4px 0">nothing captured yet</div>';
  }
  function render() {
    if (!panel) return;
    panel.querySelector('#ag-count').textContent = tweets.size;
    panel.querySelector('#ag-cap').textContent = captures;
    renderPreview();
  }
  function build() {
    if (document.getElementById('apigod-panel')) return;
    const p = document.createElement('div');
    p.id = 'apigod-panel';
    p.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483647;font:12px/1.4 system-ui,sans-serif;' +
      'background:#15202b;color:#e7e9ea;border:1px solid #38444d;border-radius:14px;padding:10px 12px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.5);width:230px';
    p.innerHTML =
      '<div style="display:flex;align-items:center;gap:7px;margin-bottom:8px">' +
      '<span style="width:9px;height:9px;border-radius:50%;background:#1d9bf0;display:inline-block"></span>' +
      '<b style="font-weight:700">API-God</b>' +
      '<span style="margin-left:auto;color:#8899a6;font-size:11px"><b id="ag-count">0</b> posts</span></div>' +
      '<div id="ag-stat" style="color:#8899a6;margin-bottom:8px">scroll to capture · <span id="ag-cap">0</span> responses</div>' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
      '<button id="ag-auto" style="flex:1">Autoscroll: OFF</button>' +
      '<input id="ag-timer" type="number" min="0" step="1" placeholder="∞" ' +
      'title="minutes to run, then stop (blank = until idle)" ' +
      'style="width:42px;background:#0f151a;color:#e7e9ea;border:1px solid #38444d;' +
      'border-radius:8px;padding:5px 6px;font:11px system-ui;text-align:center">' +
      '<span style="color:#8899a6;font-size:10px">min</span></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">' +
      '<button id="ag-jsonl">JSONL</button><button id="ag-csv">CSV</button>' +
      '<button id="ag-md">Markdown</button><button id="ag-copy">Copy</button>' +
      '<button id="ag-preview-btn">Preview</button><button id="ag-clear">Clear</button></div>' +
      '<div id="ag-preview" style="display:none;margin-top:8px;max-height:170px;overflow:auto"></div>';
    p.querySelectorAll('button').forEach((b) => (b.style.cssText =
      'background:#1d9bf0;color:#fff;border:0;border-radius:9999px;padding:6px 8px;cursor:pointer;font:11px system-ui;font-weight:700'));
    p.querySelector('#ag-clear').style.background = '#38444d';
    document.documentElement.appendChild(p);
    panel = p;
    p.querySelector('#ag-jsonl').onclick = () => { if (!tweets.size) return status('nothing captured yet'); download(toJSONL(), 'jsonl'); status(`saved ${tweets.size} → jsonl`); };
    p.querySelector('#ag-csv').onclick = () => { if (!tweets.size) return status('nothing captured yet'); download(toCSV(), 'csv'); status(`saved ${tweets.size} → csv`); };
    p.querySelector('#ag-md').onclick = () => { if (!tweets.size) return status('nothing captured yet'); download(toMarkdown(), 'md'); status(`saved ${tweets.size} → md`); };
    p.querySelector('#ag-copy').onclick = async () => { if (!tweets.size) return status('nothing captured yet'); await navigator.clipboard.writeText(toJSONL()); status(`copied ${tweets.size}`); };
    p.querySelector('#ag-auto').onclick = () => { autoTimer ? stopAuto('autoscroll off') : startAuto(); };
    const ti = p.querySelector('#ag-timer');
    ti.value = autoMins;                       // restore across SPA panel rebuilds
    ti.oninput = () => { autoMins = ti.value; };
    p.querySelector('#ag-preview-btn').onclick = () => { const pv = panel.querySelector('#ag-preview'); pv.style.display = pv.style.display === 'none' ? 'block' : 'none'; renderPreview(); };
    p.querySelector('#ag-clear').onclick = () => { stopAuto(); tweets.clear(); captures = 0; autoLastSize = 0; render(); status('cleared'); };
    updateAutoBtn(!!autoTimer);
    render();
  }
  build();
  // X is an SPA — if the panel node ever gets torn out, put it back.
  setInterval(() => { if (!document.getElementById('apigod-panel')) { panel = null; build(); } }, 2000);
})();
