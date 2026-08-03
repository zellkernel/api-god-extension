# Privacy Policy — API-God — X export

_Last updated: 2026-08-03_

API-God — X export ("the extension") is a Chrome extension that lets you export the X
(Twitter) content visible in your own logged-in browser session to a local JSONL or
markdown file.

## What data the extension handles

When you are on x.com or twitter.com, the extension reads the JSON response bodies that
X's own web page fetches from X's backend (search results, timelines, profiles) — the
same data the page renders for you. It formats that content so you can save or copy it.

## Where that data goes

**Nowhere but your own device.**

- The extension has **no server** and makes **no network requests of its own**.
- It does **not** transmit, upload, sell, or share any data with the developer or any
  third party.
- It does **not** store your X login, cookies, or session tokens. It relies on the
  session you are already logged into; it keeps no copy.
- Exports are written by your browser directly to your local disk (a normal file
  download) or copied to your clipboard when you choose. Captured content is held in the
  page's memory during your session. When you run a **Parlay** (a chain of searches that
  reloads the page between legs), the captured set and the run plan are also kept in the
  page's own `sessionStorage` so they survive those reloads — this is a standard web-page
  API scoped to x.com, held on your device only, and it is **not** the browser "storage"
  permission (no such permission is requested; see below). All of it is discarded when you
  close the tab, or press "Clear" or "Stop parlay".

## Permissions

The extension requests host access to `x.com` and `twitter.com` only, so it can run on
those pages. It requests no other permissions (no `tabs`, `storage`, `downloads`,
`scripting`, or background access).

## Data retention

The developer retains **no** user data, because none is ever collected by the developer.
Any exported files live only on your device, under your control.

## Changes

Updates to this policy will be posted at this URL with a new "Last updated" date.

## Contact

nicholas@nuclide-research.com
