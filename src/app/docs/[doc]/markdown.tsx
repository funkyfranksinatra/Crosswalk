import type { ReactNode } from "react";

/**
 * A small, dependency-free Markdown renderer for the operator docs served under /docs.
 * Everything becomes React elements (text is escaped by React); raw HTML in the source is
 * shown as text, never injected. Supports headings, paragraphs, fenced code, lists, tables,
 * block quotes, horizontal rules and the inline forms `code`, **bold**, *italic*, [links].
 */
export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0, key = 0;
  const k = () => `b${key++}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(<pre key={k()} className="mono text-[12px] rounded-lg bg-panel-2 border border-line p-3 overflow-x-auto my-3" data-lang={fence[1] || undefined}><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].replace(/\s#+$/, "");
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const cls = ["text-[20px] font-semibold mt-6 mb-2", "text-[16px] font-semibold mt-6 mb-2", "text-[14px] font-semibold mt-4 mb-1.5", "text-[13px] font-semibold mt-3 mb-1", "text-[13px] font-medium mt-3 mb-1", "text-[12.5px] font-medium mt-2 mb-1"][level - 1];
      // The page already has an h1 (the header); document headings start at h2 to keep the outline in order.
      const Tag = (`h${Math.min(6, level + 1)}`) as "h2" | "h3" | "h4" | "h5" | "h6";
      out.push(<Tag key={k()} id={id} className={cls}>{inline(text)}</Tag>);
      i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push(<hr key={k()} className="my-4 border-line" />); i++; continue; }
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(<blockquote key={k()} className="border-l-2 border-accent pl-3 my-3 text-ink-2">{renderMarkdown(buf.join("\n"))}</blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const rows: string[][] = [];
      const split = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = split(line); i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(split(lines[i++]));
      out.push(
        <div key={k()} className="overflow-x-auto my-3">
          <table className="table !text-[12.5px]"><thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? "")}</td>)}</tr>)}</tbody></table>
        </div>,
      );
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && m[1].length === li[1].length) { items.push(m[3]); i++; continue; }
        if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; continue; }
        break;
      }
      const cls = "my-2 ml-5 space-y-1 text-[13px]";
      out.push(ordered ? <ol key={k()} className={`list-decimal ${cls}`}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol> : <ul key={k()} className={`list-disc ${cls}`}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]))) buf.push(lines[i++]);
    if (!buf.length) { i++; continue; }
    out.push(<p key={k()} className="my-2 text-[13px] leading-relaxed">{inline(buf.join(" "))}</p>);
  }
  return out;
}

/** Inline forms. Links are rendered only for http(s) and same-site relative targets. */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) nodes.push(<code key={n++} className="kbd">{m[1].slice(1, -1)}</code>);
    else if (m[2]) nodes.push(<strong key={n++}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) nodes.push(<em key={n++}>{m[3].slice(1, -1)}</em>);
    else if (m[4]) {
      const href = m[6];
      const safe = /^https?:\/\//i.test(href) || (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("#");
      nodes.push(safe ? <a key={n++} className="text-accent underline" href={href} rel={/^https?:/i.test(href) ? "noreferrer" : undefined} target={/^https?:/i.test(href) ? "_blank" : undefined}>{m[5]}</a> : <span key={n++}>{m[5]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
