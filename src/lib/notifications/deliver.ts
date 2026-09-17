/**
 * External delivery of one notification on one channel. Runs on the `notify.deliver`
 * queue so a mail server hiccup is retried with backoff and never blocks the request
 * that raised the event.
 *
 *   email — SMTP via nodemailer: SMTP_URL (smtp[s]://user:pass@host:port), MAIL_FROM
 *   teams — Microsoft Teams incoming webhook: TEAMS_WEBHOOK_URL (one channel, e.g. #deal-desk)
 *
 * `NOTIFY_DRY_RUN=true` records deliveries without sending (CI, demos). Tests replace the
 * transports with `setTransportsForTests`.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { notificationsSent } from "@/lib/observability/metrics";
import type { Channel } from "./index";

type Mail = { to: string; subject: string; text: string; html: string };
type Transports = { email: (m: Mail) => Promise<void>; teams: (card: object) => Promise<void> };

let overrides: Partial<Transports> | null = null;
export function setTransportsForTests(t: Partial<Transports> | null) { overrides = t; }

async function sendEmail(m: Mail) {
  if (overrides?.email) return overrides.email(m);
  if (process.env.NOTIFY_DRY_RUN === "true") return;
  const url = process.env.SMTP_URL, from = process.env.MAIL_FROM;
  if (!url || !from) throw new Error("SMTP_URL / MAIL_FROM are not configured");
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport(url);
  await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
}

async function sendTeams(card: object) {
  if (overrides?.teams) return overrides.teams(card);
  if (process.env.NOTIFY_DRY_RUN === "true") return;
  const url = process.env.TEAMS_WEBHOOK_URL;
  if (!url) throw new Error("TEAMS_WEBHOOK_URL is not configured");
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(card) });
  if (!res.ok) throw new Error(`Teams webhook ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Deliver and record the attempt on the notification (idempotent: an already-delivered channel is skipped). */
export async function deliver(notificationId: string, channel: Channel): Promise<{ delivered: boolean; skipped?: string }> {
  const n = await prisma.notification.findUnique({ where: { id: notificationId }, include: { user: { select: { email: true, name: true, isActive: true } } } });
  if (!n) return { delivered: false, skipped: "notification gone" };
  const deliveries = (n.deliveriesJson ? JSON.parse(n.deliveriesJson) : {}) as Record<string, { at: string; ok: boolean; error?: string; attempts?: number }>;
  if (deliveries[channel]?.ok) return { delivered: true, skipped: "already delivered" };
  if (!n.user.isActive) return { delivered: false, skipped: "user inactive" };
  const attempts = (deliveries[channel]?.attempts ?? 0) + 1;
  try {
    if (channel === "email") {
      const text = [n.title, n.body ?? "", n.link ? `\n${n.link}` : ""].filter(Boolean).join("\n\n");
      const html = `<p><strong>${esc(n.title)}</strong></p>${n.body ? `<p>${esc(n.body).replace(/\n/g, "<br>")}</p>` : ""}${n.link ? `<p><a href="${esc(n.link)}">Open in Crosswalk</a></p>` : ""}<p style="color:#888;font-size:12px">Crosswalk · ${esc(n.kind)}</p>`;
      await sendEmail({ to: n.user.email, subject: `[Crosswalk] ${n.title}`, text, html });
    } else {
      // MessageCard is accepted by Teams incoming webhooks (and by Power Automate's "Post to channel" connector).
      await sendTeams({
        "@type": "MessageCard", "@context": "https://schema.org/extensions", themeColor: n.kind === "ALERT" || n.kind.endsWith("_FAILED") ? "D13438" : "0F6CBD", summary: n.title,
        sections: [{ activityTitle: n.title, activitySubtitle: `for ${n.user.name} · ${n.kind.replace(/_/g, " ").toLowerCase()}`, text: n.body ?? "" }],
        ...(n.link ? { potentialAction: [{ "@type": "OpenUri", name: "Open in Crosswalk", targets: [{ os: "default", uri: n.link }] }] } : {}),
      });
    }
    deliveries[channel] = { at: new Date().toISOString(), ok: true, attempts };
    await prisma.notification.update({ where: { id: notificationId }, data: { deliveriesJson: JSON.stringify(deliveries) } });
    notificationsSent.inc({ kind: n.kind, channel, outcome: "ok" });
    log.info("notify.delivered", { notificationId, channel, attempts });
    return { delivered: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    deliveries[channel] = { at: new Date().toISOString(), ok: false, error: error.slice(0, 500), attempts };
    await prisma.notification.update({ where: { id: notificationId }, data: { deliveriesJson: JSON.stringify(deliveries) } });
    notificationsSent.inc({ kind: n.kind, channel, outcome: "error" });
    log.warn("notify.delivery_failed", { notificationId, channel, attempts, error });
    throw e; // the queue retries with backoff
  }
}
