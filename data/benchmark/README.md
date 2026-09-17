# Benchmark cases

One directory per historical account list. Everything here except this README is
gitignored — the lists are customer purchase data.

```
data/benchmark/<case-name>/
  intake.xlsx | intake.csv      the account's competitor list: code + quantity (any intake layout)
  reference.xlsx | reference.csv  the answer key, one row per competitor code:
                                  Competitor Code | Expected SKU (A|B for several) | Match Type | Family | Notes
  meta.json                     { "account": "0001880967", "source": "PACR export REQ-7604", "note": "..." }
```

Run: `npx tsx scripts/benchmark.ts` (heuristic) or `--llm`; `--from-requests` adds every
completed request whose lines a rep reviewed (the confirmed SKU is the answer). Results are
stored as `BenchmarkRun` rows and printed per family and per tier; `--out docs/benchmarks`
writes the markdown report.

Sources for answer keys, in order of trust: marketing-validated crosses, the legacy PACR
export, reps' confirmed decisions. Record the source in `meta.json` and the Notes column.
