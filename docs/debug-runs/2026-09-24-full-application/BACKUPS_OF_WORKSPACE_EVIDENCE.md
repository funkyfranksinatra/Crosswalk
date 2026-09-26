# Backups of evidence that existed only in the workspace

Made 2026-09-24 ~21:55 UTC from branch `debug/2026-09-24-full-application` @ `45b403c`. Delivered in chat
and written to `C:\Users\4141e\Documents\Crosswalk\.claude-bundles\debug-run-2026-09-24\` on "wumpus".

| Archive | Files | Bytes | SHA-256 | Contents |
|---|---|---|---|---|
| `crosswalk-debug-run-evidence-logs-and-data.tgz` | 132 | 390,590 | `4f99babaae067d88909761ce06d97b6895f53f1b065dfdeb69c9fdeb4deeb198` | `evidence/logs/*` (every command log cited in TEST_RESULTS.md — they were gitignored by the repo-wide `*.log` rule at commit time), `evidence/ws3/logs/*.log`, `evidence/ws3/out/*` except screenshots (matrices, axe.json, journey JSON, offer PDF, CSV fixtures), `evidence/ws5/entrypoint-worker*.log` |
| `crosswalk-debug-run-screenshots-part1.tgz` | 44 | 18,900,476 | `db62f1c4e38e55ea1ec0f59a2ade963adfcd7d33287a357fe84be382f1cab489` | responsive screenshots `shot-1440-*` and `shot-390-*` for the 22 pages |
| `crosswalk-debug-run-screenshots-part2.tgz` | 15 | 15,153,036 | `fcd252d4102e044906dc8c258aa971e0ba1ff7a6aa1298b4c564b3861dfe9322` | journey screenshots (request, proposal, admin sections) and the logo fixtures |
| `crosswalk-debug-run-eval-listings-PRIVATE.tgz` | 12 | 11,214 | `9c154ae401225922ed9842210df4e5320dbbd4e62ca09635eff2270269c219df` | **PRIVATE — curated reference data.** Full per-line `npm run eval` outputs (baseline / integrated / final) and WS1's eval experiments, removed from tracked evidence on purpose (REVIEW.md REV-08). Keep outside git. |
| `crosswalk-debug-run.bundle` | — | 713,956 | `abadbca7771c1a880a7f471a57d410f94f2762d7bb6dcf75f937858d3e8991f9` | git bundle of `45b403c` on top of `ccfc6e8` (already fetched into the checkout as `debug/2026-09-24-full-application`) |

After this backup the repo's `.gitignore` gained `!docs/debug-runs/**/*.log`, and `evidence/ws3/results/`
holds a tracked copy of the non-screenshot outputs, so a later commit on this branch carries the command
logs and result files; only the 59 screenshots (37 MB) stay out of git.
