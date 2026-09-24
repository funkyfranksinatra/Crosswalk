# WS3 (frontend) evidence

All scripts are plain Node + Playwright (global `playwright` 1.56, Chromium under `/opt/pw-browsers`) and
run against the production build:

```
set -a; . ./.env.local.ws3; set +a
npm run build
JOBS_WORKER=inline INTEGRATIONS_ALLOW_MOCK=true npx next start -p 3103   # INTEGRATIONS_ALLOW_MOCK only for the integrations editor journey
node docs/debug-runs/2026-09-24-full-application/evidence/ws3/<script>.js
```

| Script | Item | What it checks | Output |
|---|---|---|---|
| `lib.js` | — | dev sign-in per role (cookie cached, 429-aware), console/pageerror/CSP collectors, sample ids | — |
| `matrix.js [out.csv]` | G | 22 pages × 12 roles (signed-out + 11): status, console/page/hydration errors, failed requests, 4xx/5xx, CSP, price visible, visible controls (`(disabled)` marked) | `out/matrix-baseline.csv`, `out/matrix-final.csv` |
| `price-gate.js` | B | server HTML/RSC grep for sentinel prices, COGS, pricebook names, model stats per role (exit 1 on a leak) | `out/price-gate-{baseline,final}.json`, `logs/price-gate-*.log` |
| `journey-request.js` | H | wizard + upload (fixtures/intake.csv), preview accounting, double-click submit, run to complete, filters, 6 bulk actions, candidate/notes/flag, side-by-side dialog (Escape, focus), 5 downloads (type/filename/magic bytes), create proposal | `out/journey-request.json`, `out/journey-request-*.png`, `out/offer.pdf` |
| `journey-proposal.js [id]` (`ROLE=SALES_REP` for the deal-desk path) | H | inline price, validation, drawer tabs, re-recommend, scenarios, logistics + tax, below-floor → submit → approve as PRICING_COMMITTEE, stale-tax export refusal, quote PDF/xlsx/csv, outcome, new version | `out/journey-proposal.json`, `logs/journey-proposal*.log` |
| `journey-admin.js [sections]` | H | contracts (GPO create, entries, commitment/rebate terms, terminate), intelligence (record/verify/dispute/import, role gates), catalog (template→re-import, sizes, enrich, add SKUs), GUDID (plan, one tiny import, idle), crosses (marketing + clinical + final review), notifications, settings (weights, logo ≤300 KB / oversized, system actions, policies), integrations editor (mock provider) | `out/journey-admin.json`, `out/journey-admin-*.png` |
| `journey-noaccount.js` | H (WS3-F11) | request without an account number → Create proposal opens the account picker → proposal for the chosen account | `out/journey-noaccount.json` |
| `navigation-state.js` | I | back/forward/refresh, deep links, missing/out-of-scope → 404, empty data role, large data (/crosses), API 500 error state, session expiry, two tabs on one proposal | `out/navigation-state.json` |
| `responsive-axe.js` | J | 4 widths × 22 pages: horizontal overflow, screenshots; axe-core (wcag2a/aa/21a/21aa/best-practice) at 1440 | `out/responsive.csv`, `out/axe.json`, `out/shot-*.png` |
| `keyboard.js` | J | skip link, Tab order, focus rings, menus/popovers/dialog via keyboard, focus trap + restore, phone menu | `out/keyboard.json` |
| `polling.js` | K | bell 30 s, system 20 s (stops on navigation, pauses hidden, catches up), request page idle, stale-reply ordering, enrich 1.5 s | `out/polling.json` |

`fixtures/intake.csv` is the wizard upload (duplicate 1190500 rows, a `Total` summary row, a notes row, a blank row, `IN-12-4`).
`logs/` holds the build/typecheck/vitest output and every script run; `logs/corrupt-next-dev-types/` are the interleaved
`.next/dev/types` files that broke the build once (see the report).

`results/` is a tracked copy of everything the scripts wrote to `out/` except the screenshots
(`out` is gitignored repo-wide): matrices, axe.json, journey/keyboard/polling/navigation JSON, the
offer PDF and the CSV fixtures. The 59 screenshots are in the backup archive
`crosswalk-debug-run-screenshots-part{1,2}.tgz` (see ../../BACKUPS_OF_WORKSPACE_EVIDENCE.md).
