"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function CrossFilters({ q, type, company, source, companies, sources, shown }: { q: string; type: string; company: string; source: string; companies: { name: string; count: number }[]; sources: { name: string; count: number }[]; shown: number }) {
  const router = useRouter();
  const [search, setSearch] = useState(q);
  const nav = (patch: Record<string, string>) => router.push(`/crosses?${new URLSearchParams({ q, type, company, source, ...patch }).toString()}`);
  useEffect(() => {
    const t = setTimeout(() => { if (search !== q) nav({ q: search }); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2 flex-wrap">
      <select className="input w-auto" value={type} onChange={(e) => nav({ type: e.target.value })}>
        <option value="">All match types</option><option>Exact Match</option><option>Close Match</option><option>Alternative Match</option><option>US Downsell Match</option>
      </select>
      <select className="input w-auto" value={company} onChange={(e) => nav({ company: e.target.value })}>
        <option value="">All competitors</option>
        {companies.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
      </select>
      <select className="input w-auto" value={source} onChange={(e) => nav({ source: e.target.value })}>
        <option value="">All sheets</option>
        {sources.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.count})</option>)}
      </select>
      <input className="input w-[280px]" placeholder="Search SKU, code, description…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <span className="ml-auto text-[12.5px] text-muted">{shown} shown{shown === 400 ? " (first 400)" : ""}</span>
    </div>
  );
}
