# reverse-engineered-jobright

<img src="static/icons/icon128.png" width="64" alt="" align="right" style="image-rendering:pixelated">

**Autofill Jobs**: a local-only Chrome extension that autofills job applications on **Workday, Greenhouse, Ashby, Lever** (and most other forms) from multiple resume profiles. No server, no account, no LLM, no Docker. Everything lives in `chrome.storage.local`.

## How it works

- **Profiles.** One JSON file holds a shared `base` (name, contact, education, work authorization, EEO answers, salary, answer bank) plus one entry per resume whose `overrides` change only what differs (summary, bullets, skills, location...). See [`profiles/example.json`](profiles/example.json).
- **Fill.** Press the floating **Autofill** button, the toolbar icon (opens the side panel), or `Alt+Shift+F`. The side panel also has **Only empty fields** (leave what the site or you already filled) and **Just the field I clicked** (`Alt+Shift+D`).
  1. Uploads the profile's resume first and waits for the upload (and the site's own resume parsing) to finish.
  2. Finds every field and reads its question the way a human would (label, `aria-labelledby`, fieldset legend, Workday `formField-*`, nearby text).
  3. Maps the question to a profile value (rules, your answer bank, answers it learned from you), with a confidence score.
  4. Fills text inputs, native selects, radios, checkboxes, Yes/No button groups and custom dropdowns (react-select, Workday prompts). For dropdowns it types, waits for options to load, picks the closest match, and checks the result.
  5. Retries a field a few times, then gives up and **flags** it: orange outline on the page plus a "Needs you" list in the side panel (click a row to jump to the field).
- **Multi-page (Workday).** After a page with no blocking flags it clicks **Save and Continue**, waits for the next page, and keeps going. It adds Work Experience / Education entries with the **Add** button. It **never clicks Submit**; it stops at Review.
- **Never auto-answered:** consent/"I agree" checkboxes, cover letters, free-text essay questions, and anything you leave as `null` in your profile (e.g. `eeo.ethnicity`).
- **Progress and Cancel.** The side panel and the floating button show what it's doing right now ("Picking "Country" — waiting for its options…"), with a Cancel / Stop button that stops it right away.
- **Pages that reload (Taleo).** If Next or "I want to upload my resume" reloads the whole page, the fill starts again on the new page. Any other reload mid-fill just ends the run, so the side panel never gets stuck on "Filling…".
- **Job site login.** Save one email + password in Options → Job site login; it's used on sign-up and sign-in pages when you press Fill. It's kept in this browser's local storage (not encrypted, never synced) and never shown in the side panel.
- **Learning.** When you answer a flagged question yourself, the side panel asks (✓ / ✕) whether to save the question → answer for next time, showing any answer it would replace. Manage saved answers in Options.
- **AI answers (optional).** Questions the rules can't answer ("Do you have relatives working at Deloitte?") go to a model on OpenRouter with a short profile summary (no contact details or EEO answers) and your standing answers. Answers it isn't sure of are only suggested, never filled. Answers are cached and reused.
- **Autopilot.** Side panel → **Autopilot** opens a queue of job links (paste them, import a CSV, or load the sample). Press **Start** and it works through them one at a time in its own window: clicks Apply, signs up or signs in with your saved login, fills every page, and stops at Submit for you to review (or submits on its own if you turn that on). Anything only you can do (email codes, CAPTCHAs, questions it can't answer, sign-in failures) goes to **Needs you** with its tab kept open; fix it there and press **Done — continue** to pick up where it stopped. It has a daily limit (default 100), a randomised pause between jobs, a per-job timeout, and pauses itself when too many jobs are waiting on you. LinkedIn Easy Apply and Indeed's own Apply are skipped.

## Setup

```bash
npm install
npm run build
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `dist/` folder.
2. Open the extension's **Options** page, click **Import profile JSON** and pick your profile file.
3. On each profile, click **Attach PDF** and choose that profile's resume.
4. Open a job application and press **Autofill**.
5. Optional: in Options, save your **Job site login**, and an OpenRouter key under **AI answers** (press **Test** to check the key and model). Review the standing answers there.
6. For Autopilot: side panel → **Autopilot** → **Load sample CSV** (or paste links) → **Start**. Keep its window open and not minimized.

After changing code: `npm run build` (or `npm run watch`), then click the reload icon on the extension card and reload the job page.

**Your own profile, preloaded.** If `profiles/<you>.json` exists, the build bundles it, the resumes in `profiles/resumes/` (named as each profile's `resumeFileName`) and the login and AI settings in `profiles/account.json` (`email`, `password`, `openrouterKey`, `model`) into `dist/seed/`, and the extension imports them on install and on every reload when they've changed. Steps 2–3 then happen by themselves. All of these files are gitignored; build with `SEED=0` for a copy without them.

## Your data

`profiles/*` (except `example.json`) and `*.pdf` are gitignored, so your real profile never lands in the repo. Use **Export JSON** in Options for a backup. The job-site login is stored separately and isn't included in the export.

## Development

```bash
npm test          # vitest + jsdom: matching, classification, simulated Greenhouse/Workday forms
npm run typecheck
```

To try the engine on a live page without the extension, paste `dist/inject.js` into DevTools, then run `__rej.scan()` (shows what each field is classified as) or `await __rej.fill(profileJson, 'swe')`. It fills but never submits.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how it all works: the three extension runtimes, how fields are found, how differently worded questions map to the same answer, and how each widget is filled.

Layout:

| Path | What |
| --- | --- |
| `src/engine/fields.ts` | Field discovery and question-text extraction |
| `src/engine/answers.ts` | Question → profile key rules, and key → answer |
| `src/engine/match.ts` | Option matching (yes/no, decline, alternates) with scores |
| `src/engine/widgets.ts` | Filling each widget type, including async dropdowns |
| `src/engine/fill.ts` | Page fill loop, resume upload, retries, flagging |
| `src/engine/run.ts` | Multi-page driver, single-field fill, highlighting, learning |
| `src/engine/control.ts` | Cancel flag and live status line |
| `src/engine/nav.ts` | Next / Submit / Apply buttons on sites without an adapter |
| `src/adapters/` | Per-ATS detection, resume input, Workday sections and navigation |
| `src/queue/` | Autopilot: queue storage, CSV, the background runner |
| `src/content/autopilot.ts` | Autopilot's page side: what a page is, and one step on it |
| `src/llm/` | OpenRouter client and the profile summary the model sees |
| `src/ui/` | Side panel, options page, Autopilot queue page |
