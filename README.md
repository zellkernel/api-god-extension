# API-God — X export (Chrome extension)

**It reads the answer to a request the page was going to make anyway.** It doesn't forge
API calls, doesn't scrape rendered HTML. X makes the authenticated request; the extension
tees the JSON response.

## What it is

A Chrome extension that turns your already-logged-in X tab into a local export tool.
When you search or scroll, X's own JavaScript calls its internal GraphQL backend and
renders the JSON; the extension reads those response bodies in the page and exports them
to JSONL/markdown. You never authenticate to anything — it runs inside the tab you
already signed into.

## Why that matters

Reading X's own response — instead of forging requests or parsing rendered HTML — is the
one property that separates it from a DOM scraper:

| Compared to | They do | This does instead |
|---|---|---|
| **DOM scrapers / Nitter** | Parse rendered HTML; race the paint; break on UI redesigns; run on a third-party server | Reads the structured JSON X itself fetched — captures `followers / blue / views / quotes` the rendered page omits; survives UI redesigns; stays inside your own session |

## How it works

X is a single-page app — open a search or profile and it runs a GraphQL query
(`SearchTimeline`, `UserTweets`, `ListLatestTweetsTimeline`, `HomeTimeline`, …) and
renders the JSON. The extension reads the answer to a request the page makes anyway:

```
X's JS fires SearchTimeline ─► patched fetch/XHR tees the response ─► parse ─► JSONL / markdown
```

- `inject.js` (page main world) patches `window.fetch` + `XMLHttpRequest` to tee the
  GraphQL **response bodies** — MV3 removed blocking-`webRequest` body access, so this is
  how you read them. It never forges a request; X makes the authenticated call, the
  extension reads the result.
- `content.js` (isolated world) parses X's timeline JSON into flat records (parser
  parity-tested byte-for-byte against a reference implementation), dedupes by tweet id,
  and exports.

Per record: `id, handle, name, text, time, url, likes, replies, reposts, followers, blue,
verified, views, quotes, lang, is_retweet, source`.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open [x.com](https://x.com) logged in — an **API-God** panel appears bottom-right
4. Search or scroll; the counter climbs as responses land. Click **JSONL**, **Markdown**, or **Copy JSONL**.

## Scope

Runs under your own account and session, over your own view — the same posts the page
already showed you. No firehose, no full-archive, no key: it's bounded to what your
session can see, at browsing speed. Automated/bulk access to X's internal endpoints can
violate X's terms and risk the account; that call is the operator's. Capture and export
only — it makes no network calls of its own.

## License

MIT © 2026
