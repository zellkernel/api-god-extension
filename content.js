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
  let autoTimer = null, autoLastSize = 0, autoIdle = 0, autoDeadline = 0, autoMins = '', pvFilter = '';
  let parlayLegs = [{ q: '', mins: '' }], parlayTimer = null, parlayActive = false;
  const PKEY = 'apigod_parlay', RKEY = 'apigod_parlay_recs';   // sessionStorage keys (x.com origin)
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
  // so each tick jumps straight to the bottom to trip its loader. It fires about once a
  // second — each hit loads a whole page (~20 posts), so throughput stays high while
  // staying easy on X's rate limits (firing faster just spams scrolls mid-fetch and trips
  // them). The extension itself still fetches nothing. OFF by default; stops on whichever
  // comes first: the timer you set (blank = none) or an idle stretch with no new posts.
  const AUTO_MS = 900, AUTO_IDLE_MAX = 10;   // ~1 tick/sec; ~9s of no growth = stop
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
  // Type a query, run it on X. A full navigation (not SPA nav) is deliberate: it reloads
  // the page so inject.js re-patches fetch at document_start before X's bundle captures
  // its own fetch reference — the cleanest capture path. Default tab is Top (cached,
  // robust); flip to Latest in X's own UI if you want chronological.
  function runOnX(q) {
    q = (q || '').trim();
    if (!q) return status('type a search first');
    status('searching X: ' + q.slice(0, 28));
    location.href = 'https://x.com/search?q=' + encodeURIComponent(q) + '&src=typed_query';
  }
  // Repaints ONLY the list node — the search input is built once and left alone, so
  // typing and scroll survive incoming captures. Live-filters on handle/name/text.
  function renderPreview() {
    const pv = panel && panel.querySelector('#ag-preview');
    if (!pv || pv.style.display === 'none') return;
    const list = pv.querySelector('#ag-pv-list');
    const cnt = pv.querySelector('#ag-pv-count');
    if (!list) return;
    const f = pvFilter.trim().toLowerCase();
    const all = records();
    const matched = f
      ? all.filter((r) => (r.handle + ' ' + r.name + ' ' + r.text).toLowerCase().includes(f))
      : all;
    const shown = matched.slice(-50).reverse();
    if (cnt) cnt.textContent = all.length
      ? (f ? matched.length + ' of ' + all.length + ' match' : 'showing ' + shown.length + ' of ' + all.length)
      : '';
    list.innerHTML = shown.length
      ? shown.map((r) =>
          '<div style="padding:4px 0;border-top:1px solid #22303c">' +
          '<b>' + esc(r.handle) + '</b> ' +
          '<span style="color:#8899a6">' + (r.likes || 0).toLocaleString() + '♥</span><br>' +
          '<span style="color:#c9d3da">' + esc(r.text).slice(0, 140) + '</span></div>'
        ).join('')
      : '<div style="color:#8899a6;padding:4px 0">' +
        (all.length ? 'no matches — press Go X to search X for it' : 'nothing captured yet') + '</div>';
  }
  // ---------- Parlay: a chain of {search term, minutes} legs run back-to-back ----------
  // Each leg navigates X to its search and autoscrolls for its duration, capturing into
  // the shared deduped set. Because every leg is a full page load (see runOnX), the plan
  // and the captured records are parked in the page's sessionStorage so they survive the
  // reloads; resumeParlay() picks the chain back up on the next load. No extra permission:
  // sessionStorage is the x.com origin's own store, local-only, cleared when the tab closes.
  function loadPlan() { try { return JSON.parse(sessionStorage.getItem(PKEY) || 'null'); } catch (_) { return null; } }
  function savePlan(p) { try { sessionStorage.setItem(PKEY, JSON.stringify(p)); } catch (_) {} }
  function clearPlan() { try { sessionStorage.removeItem(PKEY); sessionStorage.removeItem(RKEY); } catch (_) {} }
  function persistRecs() { try { sessionStorage.setItem(RKEY, JSON.stringify(records())); return true; } catch (_) { return false; } }
  function rehydrateRecs() {
    try { const a = JSON.parse(sessionStorage.getItem(RKEY) || '[]');
      for (const r of a) if (r && r.id && !tweets.has(r.id)) tweets.set(r.id, r); } catch (_) {}
  }
  function gotoLeg(p, idx) {                    // set the leg's clock, save state, navigate to its search
    p.idx = idx; p.active = true;
    p.legDeadline = Date.now() + p.legs[idx].mins * 60000;
    if (!persistRecs()) status('parlay: capture set too big to carry — export soon');
    savePlan(p);
    location.href = 'https://x.com/search?q=' + encodeURIComponent(p.legs[idx].q) + '&src=typed_query';
  }
  function startParlay() {
    const legs = parlayLegs
      .filter((l) => String(l.q).trim() && parseFloat(l.mins) > 0)
      .map((l) => ({ q: String(l.q).trim(), mins: parseFloat(l.mins) }));
    if (!legs.length) return status('parlay: add a leg (term + minutes)');
    gotoLeg({ legs: legs, idx: 0, active: true, legDeadline: 0 }, 0);   // carries current captures in
  }
  function advanceParlay(p) {
    stopAuto(); persistRecs();
    const next = p.idx + 1;
    if (next >= p.legs.length) return finishParlay();
    gotoLeg(p, next);
  }
  function finishParlay() {
    if (parlayTimer) { clearInterval(parlayTimer); parlayTimer = null; }
    stopAuto(); clearPlan(); parlayActive = false; renderParlay();
    status(`parlay done · ${tweets.size} posts — export when ready`);
  }
  function stopParlay() {
    if (parlayTimer) { clearInterval(parlayTimer); parlayTimer = null; }
    stopAuto(); clearPlan(); parlayActive = false; renderParlay();
    status(`parlay stopped · ${tweets.size} posts`);
  }
  function startParlayRun(p) {                  // called on load once we're on a leg's search page
    parlayActive = true;
    const box = panel && panel.querySelector('#ag-parlay'); if (box) box.style.display = 'block';
    renderParlay();
    autoMins = ''; startAuto();                 // parlay owns the timing; leg-scoped autoscroll
    if (parlayTimer) clearInterval(parlayTimer);
    let n = 0;
    parlayTimer = setInterval(() => {
      const cur = loadPlan();
      if (!cur || !cur.active) { clearInterval(parlayTimer); parlayTimer = null; return; }
      const left = cur.legDeadline - Date.now();
      status(`parlay ${cur.idx + 1}/${cur.legs.length} · "${cur.legs[cur.idx].q}" · ${Math.max(0, Math.ceil(left / 1000))}s · ${tweets.size} posts`);
      if (++n % 3 === 0) persistRecs();          // ~every 3s: survive a manual mid-leg reload
      if (left <= 0) { clearInterval(parlayTimer); parlayTimer = null; advanceParlay(cur); }
    }, 1000);
  }
  function resumeParlay() {                      // run once per page load
    const p = loadPlan();
    if (!p || !p.active) return;
    rehydrateRecs(); render();
    if (p.idx >= p.legs.length) return finishParlay();
    if (!p.legDeadline || p.legDeadline <= Date.now()) return advanceParlay(p);  // leg elapsed while away
    startParlayRun(p);
  }
  function renderParlay() {
    const box = panel && panel.querySelector('#ag-parlay');
    if (!box || box.style.display === 'none') return;
    const wrap = box.querySelector('#ag-parlay-legs');
    const startBtn = box.querySelector('#ag-parlay-start');
    const addBtn = box.querySelector('#ag-parlay-add');
    const plan = loadPlan();
    const running = !!(plan && plan.active);
    if (running) {                              // read-only view of the chain in flight
      wrap.innerHTML = plan.legs.map((l, i) =>
        `<div style="padding:3px 0;color:${i === plan.idx ? '#1d9bf0' : '#8899a6'}">` +
        `${i === plan.idx ? '▶' : '·'} ${esc(l.q)} · ${l.mins}m</div>`).join('');
      addBtn.style.display = 'none';
      startBtn.textContent = 'Stop parlay'; startBtn.style.background = '#f4212e';
    } else {                                     // editable draft: term + minutes per leg
      wrap.innerHTML = parlayLegs.map((l, i) =>
        `<div style="display:flex;gap:4px;margin-bottom:4px" data-i="${i}">` +
        `<input class="ag-pl-q" placeholder="search term" value="${esc(l.q)}" ` +
        `style="flex:1;min-width:0;background:#0f151a;color:#e7e9ea;border:1px solid #38444d;border-radius:8px;padding:4px 6px;font:11px system-ui">` +
        `<input class="ag-pl-m" type="number" min="0" step="0.5" placeholder="min" value="${esc(l.mins)}" ` +
        `style="width:38px;background:#0f151a;color:#e7e9ea;border:1px solid #38444d;border-radius:8px;padding:4px 4px;font:11px system-ui;text-align:center">` +
        `<button class="ag-pl-x" title="remove leg" style="background:#38444d;color:#fff;border:0;border-radius:8px;padding:0 8px;cursor:pointer;font:12px system-ui">×</button></div>`).join('');
      addBtn.style.display = '';
      startBtn.textContent = 'Start parlay'; startBtn.style.background = '#00ba7c';
      wrap.querySelectorAll('[data-i]').forEach((row) => {   // update model on input; no re-render → focus survives
        const i = +row.getAttribute('data-i');
        row.querySelector('.ag-pl-q').oninput = (e) => { parlayLegs[i].q = e.target.value; };
        row.querySelector('.ag-pl-m').oninput = (e) => { parlayLegs[i].mins = e.target.value; };
        row.querySelector('.ag-pl-x').onclick = () => { parlayLegs.splice(i, 1); if (!parlayLegs.length) parlayLegs.push({ q: '', mins: '' }); renderParlay(); };
      });
    }
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
      'box-shadow:0 6px 24px rgba(0,0,0,.5);width:230px;max-height:calc(100vh - 32px);overflow:auto';
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
      '<button id="ag-preview-btn">Preview</button><button id="ag-parlay-btn">Parlay</button>' +
      '<button id="ag-clear" style="grid-column:1/3">Clear</button></div>' +
      '<div id="ag-parlay" style="display:none;margin-top:8px;border-top:1px solid #22303c;padding-top:8px">' +
      '<div style="color:#8899a6;font-size:10px;margin-bottom:6px">chain of searches — each runs for its minutes, then the next</div>' +
      '<div id="ag-parlay-legs"></div>' +
      '<div style="display:flex;gap:6px;margin-top:4px">' +
      '<button id="ag-parlay-add" style="flex:1;background:#38444d">+ Add leg</button>' +
      '<button id="ag-parlay-start" style="flex:1;background:#00ba7c">Start parlay</button></div></div>' +
      '<div id="ag-preview" style="display:none;margin-top:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:6px">' +
      '<input id="ag-pv-search" type="text" placeholder="filter captured · Go X to search" ' +
      'title="type to filter what you captured; Enter or Go X runs it as a search on X" ' +
      'style="flex:1;min-width:0;background:#0f151a;color:#e7e9ea;border:1px solid #38444d;' +
      'border-radius:8px;padding:5px 7px;font:11px system-ui">' +
      '<button id="ag-pv-gox" title="run this search on X">Go X</button></div>' +
      '<div id="ag-pv-count" style="color:#8899a6;font-size:10px;margin-bottom:4px"></div>' +
      '<div id="ag-pv-list" style="max-height:150px;overflow:auto"></div></div>';
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
    const sx = p.querySelector('#ag-pv-search');
    sx.value = pvFilter;                       // restore across SPA panel rebuilds
    sx.oninput = () => { pvFilter = sx.value; renderPreview(); };
    sx.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runOnX(sx.value); } };
    p.querySelector('#ag-pv-gox').onclick = () => runOnX(sx.value);
    p.querySelector('#ag-parlay-btn').onclick = () => { const b = panel.querySelector('#ag-parlay'); b.style.display = b.style.display === 'none' ? 'block' : 'none'; renderParlay(); };
    p.querySelector('#ag-parlay-add').onclick = () => { parlayLegs.push({ q: '', mins: '' }); renderParlay(); };
    p.querySelector('#ag-parlay-start').onclick = () => { (loadPlan() || {}).active ? stopParlay() : startParlay(); };
    p.querySelector('#ag-clear').onclick = () => { if ((loadPlan() || {}).active) stopParlay(); stopAuto(); tweets.clear(); captures = 0; autoLastSize = 0; pvFilter = ''; sx.value = ''; render(); status('cleared'); };
    updateAutoBtn(!!autoTimer);
    render();
  }
  build();
  resumeParlay();   // if a parlay was mid-chain before this navigation, pick it back up
  // X is an SPA — if the panel node ever gets torn out, put it back.
  setInterval(() => { if (!document.getElementById('apigod-panel')) { panel = null; build(); } }, 2000);
})();
