# Demo data (mac-demo branch)

`demo-usage-list.csv` is a fictional hospital usage list — competitor catalog numbers, annual
quantities and the prices the customer reports paying — in the two-column-plus-price shape
Crosswalk's intake expects. Paste it into **New request** (or upload the file) to run a demo:
the codes are real public catalog numbers from Gore, Ethicon, Bard and Applied Medical, and the
`prisma/seed-demo.ts` seed gives the catalog approved crosses for every one of them, so the run
produces a complete cross-reference and a priced contract offer without the reference
spreadsheets that stay out of git. The last line (PPM1510X3) is one of our own SKUs, to show the
"already ours" case.

Five of the codes (1DLMC05, SPMII, 1190500, PPM1510X3, 1410015010) resolve from recorded openFDA
responses even with no internet; the rest need openFDA reachable.
