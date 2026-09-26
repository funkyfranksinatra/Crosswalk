import Link from "next/link";

/** Unknown routes and resources a page reported with notFound(). The layout (sidebar, sign-in gate) still wraps it. */
export default function NotFound() {
  return (
    <div className="card p-8 max-w-xl mx-auto mt-10 text-center">
      <div className="text-[16px] font-semibold text-ink">Page not found</div>
      <p className="text-muted mt-2 text-[13px]">There is nothing at this address, or it belongs to a record outside your book of business.</p>
      <div className="mt-5 flex justify-center gap-2">
        <Link href="/" className="btn-primary">Overview</Link>
        <Link href="/requests" className="btn-secondary">Requests</Link>
      </div>
    </div>
  );
}
