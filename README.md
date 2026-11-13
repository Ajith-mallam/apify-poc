# Facebook Post Collector (Apify demo)

A small web app that collects recent public posts from any public Facebook page using the Apify actor
[`apify/facebook-posts-scraper`](https://apify.com/apify/facebook-posts-scraper). It shows each step live,
downloads the post images, fingerprints everything with SHA-256, verifies it, and lets the user download the
result as a ZIP.

- Deploys to **Vercel** as static files plus a few small serverless functions. No database, no always-on server.
- Runs locally with `npm run ui`, using exactly the same code.
- One dependency: the official [`apify-client`](https://www.npmjs.com/package/apify-client). Everything else uses
  Node built-ins, plus Web Crypto in the browser.

## How it works

```
Browser                          Vercel Functions (/api/*)            Apify
───────                          ─────────────────────────            ─────
Start ─────────────────────────► /api/start  validate page ─────────► start run (cost-capped)
poll  ─────────────────────────► /api/status  (long poll) ──────────► run status
      ◄──────── posts + content hashes ── /api/result ◄───────────── dataset
images ────────────────────────► /api/image  (signed proxy) ────────► Facebook CDN
SHA-256 of every image, posts.json + manifest, verify, Download ZIP
```

- **Why there are server functions:** the Apify token must stay secret, so it lives only in the functions
  (environment variable). It is never sent to the browser.
- **No database:** Apify keeps the run; the collected data stays in the user's browser tab until they download the
  ZIP. Nothing is stored on the server. Closing the tab discards the results.

## Setup (local)

```powershell
npm install
Copy-Item .env.example .env
code .env        # fill in the values below
npm run check-config
npm run check-apify
npm run ui       # http://127.0.0.1:4321/
```

| Variable | Meaning |
|---|---|
| `APIFY_TOKEN` | **Required.** Apify API token (Console → Settings → API & Integrations). Secret: never committed, logged or sent to the browser. |
| `DEMO_ACCESS_CODE` | Optional but **recommended when deployed.** If set (at least 6 characters), visitors must enter this code before they can run anything. |
| `EXAMPLE_PAGES` | Optional. Comma-separated example pages shown as one-click suggestions. Not a restriction. (`AUTHORIZED_PAGES` is accepted as the old name.) |
| `DEFAULT_PAGE_URL` | Optional. Page pre-filled in the page box. |
| `MAX_POSTS` | Optional upper limit on posts per run. Empty or `0` means no limit. |
| `UI_PORT` | Local only. Port for `npm run ui` (default 4321). |

## Deploy to Vercel

1. Push this folder to a GitHub repository (`.env` and `output/` are git-ignored), then in Vercel choose
   **Add New → Project** and import the repository. Leave the framework preset as **Other**; `vercel.json` already
   sets everything (static files from `public/`, functions in `api/`).
   Or, without GitHub: `npx vercel` in this folder (`.vercelignore` keeps `.env` and `output/` out of the upload).
2. In **Project → Settings → Environment Variables** add `APIFY_TOKEN` and `DEMO_ACCESS_CODE` (and optionally
   `EXAMPLE_PAGES`, `DEFAULT_PAGE_URL`, `MAX_POSTS`). Redeploy after changing them.
3. Open the deployment URL, enter the access code and run a collection.
4. Send the client the URL **and** the access code separately.

Recommended for a public link: in Apify Console → Billing, set a **monthly usage limit**, so the Apify account can
never be charged more than you're willing to spend, whoever uses the link.

Limits on the Vercel Hobby plan are not a problem here: each function call is short (status calls long-poll for
about 10 seconds; the result call waits up to 20 seconds for Apify to finalise the cost), and images are proxied one
at a time (up to 4 MB each).

## Commands

| Command | What it does |
|---|---|
| `npm run ui` | Run the web app locally at http://127.0.0.1:4321/ (`-- --port N` to change). Calls Apify. |
| `npm run collect -- [page] [count]` | Collect from the terminal and save to `output/<page>/<run>/` on disk. |
| `npm run verify` | Re-hash every run saved by `collect` and report mismatches (exit code 1 on failure). |
| `npm run check-config` | Validate `.env` and print a summary (secrets never shown). |
| `npm run check-apify` | Confirm the token works; print plan and remaining credit. |
| `npm run raw -- [page] [count]` | Developer tool: print raw actor output (saved to `output/_raw/`, which contains commenter data, so delete it after use). |
| `npm test` | Run the automated tests. |

## What the ZIP contains

```
<page>-<YYYYMMDD-HHMMSS>/
  posts.json           normalised posts + Apify run/dataset IDs + cost
  posts.json.sha256    sha256sum-format manifest for posts.json
  images/              downloaded images, e.g. 01_<postId>_0.jpg
```

Each post record has `postId, pageName, pageUrl, postUrl, postedAt, text, likes, comments, shares, mediaType,
images[], collectedAt`, plus `contentSha256`. Missing values are `null`, never guessed. A failed image download is
recorded on the image (`error`) and doesn't stop the run.

### Integrity (SHA-256)

- **Content hash per post:** SHA-256 of the UTF-8 JSON `["fbpoc-post-v1", postId, postUrl, postedAt, text]`,
  strings NFC-normalised. Engagement counts are excluded on purpose, because they change over time. Computed by the
  server and recomputed in the browser; the run fails if they disagree.
- **Image hash:** the server hashes each image as it fetches it from Facebook's CDN and sends the hash in a header;
  the browser hashes the bytes it received and refuses the image if they differ.
- **Manifest:** `posts.json.sha256` covers `posts.json`. After unzipping, check it with standard tools:
  `sha256sum -c posts.json.sha256` (Linux/macOS) or `Get-FileHash posts.json` (PowerShell).

The **Verify integrity** step and the **Re-verify stored files** button re-hash the stored bytes. These hashes
detect accidental or casual changes. They aren't a digital signature: someone who edits a post and recomputes every
hash wouldn't be detected.

## When a page can't be collected

Every failure stops the stepper at the step where it happened and shows a red panel with the exact reason, who
reported it (this app, Apify or Facebook), Facebook's or Apify's own message word for word, and what to do next.

| Where | Code | Typical cause |
|---|---|---|
| Validate | `invalid-page-url` | Not a facebook.com URL, or a group, event, single post or other non-page link. Apify isn't called, so it costs nothing. |
| Start | `apify-token-invalid`, `apify-out-of-credit`, `apify-rate-limited`, `apify-unreachable` | Problem with the Apify account or the connection to Apify. |
| Scrape | `apify-run-failed`, `apify-run-timed-out`, `apify-run-aborted` | The scraper itself failed. Apify's status message is shown. |
| Fetch | `page-not-available` | Facebook says the page doesn't exist, was deleted, or isn't public (actor error `not_available`). |
| Fetch | `no-posts`, `no-usable-posts`, `scraper-error` | The page has no public posts, or the scraper reported some other error code (shown as is). |

The actor reports a missing or private page as a *successful* run with an error item, so the app checks the result
itself. A failed run still costs the Apify run-start fee ($0.001), which the log reports.

## Compliance and safety

- **Any public page:** users can enter any Facebook page URL. Groups, events, single posts and other websites are
  refused before Apify is called.
- **Public post data only.** No login, no cookies, no private groups.
- **No evasion.** No stealth plugins, CAPTCHA bypass, fingerprint spoofing or proxy rotation of our own. The actor
  runs with its default settings.
- **Minimal personal data:** commenters' names and comments, profile pictures and tagged users are not kept.
- **Predictable cost:** the UI shows the maximum cost before each run, and Apify is given that amount as a hard
  `maxTotalChargeUsd` cap. `MAX_POSTS` adds a per-run limit if set.
- **Token safety:** the token lives only in `.env` locally or in Vercel's environment variables. It is hidden from
  logs and serialised config, scrubbed from every API response, and never sent to the browser.
- **API protection:** optional access code (checked in constant time, with a delay on wrong codes); same-origin and
  JSON checks on POST (CSRF); run tickets and image URLs are HMAC-signed, so the API only reads runs it started and
  can't be used as an open proxy; images only from Facebook's CDN (`*.fbcdn.net`, https, every redirect checked).
- **Browser:** strict Content-Security-Policy; all scraped text is rendered as text, never as HTML.
- **Local server:** binds to 127.0.0.1 and checks the Host header (DNS rebinding).
- **Responsibility:** whoever runs a collection must make sure they're allowed to collect from that page, and that
  collecting and storing this data complies with Facebook's terms and applicable data-protection law.

## Known limitations

- Results exist only in the browser tab until the ZIP is downloaded; there is no run history (no database).
- Facebook image URLs expire after a few days, so images are fetched during the run.
- Images larger than 4 MB are recorded as failed in the hosted version (Vercel's response size limit).
- Very large runs (hundreds of posts) haven't been tested; the browser holds all images in memory.
- Personal profiles that are public may also return posts; the app can't tell a page from a profile by URL alone.
- Video posts are handled from the actor's documented schema but haven't yet been seen in a real run.
- `npm audit` reports a high-severity issue in `basic-ftp` (pulled in by `apify-client` → `proxy-agent`). The
  vulnerable FTP code is never used by this app. `npm audit fix --force` would downgrade `apify-client`, so it hasn't
  been applied.
