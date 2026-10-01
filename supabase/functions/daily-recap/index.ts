// Supabase Edge Function: daily-recap
// Emails the help desk recap through Microsoft Graph at 5 AM Eastern.
//
// Secrets (Edge Functions → Secrets):
//   CRON_SECRET            any long random string; must match 02_schedule_recap.sql
//   MS_TENANT_ID           Entra tenant (directory) ID
//   MS_MAILER_CLIENT_ID    "Help Desk Mailer" app registration client ID
//   MS_MAILER_CLIENT_SECRET that app's client secret
//   RECAP_FROM             mailbox the email is sent from, e.g. jmccord@1915south.com
//   RECAP_TO               comma-separated recipients
//   APP_URL                the help desk web address, e.g. https://YOUR-GITHUB-NAME.github.io/helpdesk
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const TZ = "America/New_York";
const PRIORITIES = [
  { name: "High", color: "#dc2626", bg: "#fee2e2" },
  { name: "Medium", color: "#a16207", bg: "#fef9c3" },
  { name: "Low", color: "#15803d", bg: "#dcfce7" },
];

type Ticket = {
  id: number;
  created_at: string;
  location: string;
  category: string;
  priority: string;
  status: string;
  title: string;
  requester_name: string | null;
  is_sale: boolean;
  sale_number: string | null;
};

function env(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing secret: ${key}`);
  return v;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

function easternHour(d = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d),
  );
}

function age(iso: string): string {
  const hrs = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function buildEmail(open: Ticket[], newCount: number, resolvedCount: number, appUrl: string) {
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "long", month: "long", day: "numeric",
  }).format(new Date());

  const stat = (label: string, value: number | string, color = "#0f172a") =>
    `<td style="padding:12px 16px;border:1px solid #e2e8f0;border-radius:8px;text-align:center">
       <div style="font-size:24px;font-weight:700;color:${color}">${value}</div>
       <div style="font-size:12px;color:#64748b">${label}</div></td>`;

  const byPriority = (p: string) => open.filter((t) => t.priority === p);

  const sections = PRIORITIES.map((p) => {
    const rows = byPriority(p.name);
    if (!rows.length) return "";
    const trs = rows.map((t) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0;white-space:nowrap">
          <a href="${esc(appUrl)}/#/ticket/${t.id}" style="color:#1d4ed8">#${t.id}</a></td>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0">${esc(t.title)}
          <div style="font-size:12px;color:#64748b">${esc(t.category)}${t.is_sale ? ` · Sale ${esc(t.sale_number)}` : ""}</div></td>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0">${esc(t.location)}</td>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0">${esc(t.requester_name)}</td>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0">${esc(t.status)}</td>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right">${age(t.created_at)}</td>
      </tr>`).join("");
    return `
      <h2 style="margin:28px 0 8px;font-size:16px;color:${p.color}">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color};margin-right:6px"></span>
        ${p.name} priority (${rows.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;border-left:4px solid ${p.color}">
        <tr style="background:${p.bg};text-align:left;font-size:12px;color:#334155">
          <th style="padding:8px">#</th><th style="padding:8px">Ticket</th><th style="padding:8px">Location</th>
          <th style="padding:8px">From</th><th style="padding:8px">Status</th><th style="padding:8px;text-align:right">Age</th>
        </tr>${trs}
      </table>`;
  }).join("");

  const locCounts = new Map<string, number>();
  for (const t of open) locCounts.set(t.location, (locCounts.get(t.location) ?? 0) + 1);
  const locLine = [...locCounts.entries()].sort().map(([l, n]) => `${esc(l)}: <b>${n}</b>`).join(" &nbsp;·&nbsp; ");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
  <div style="max-width:760px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
    <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">1915 South Help Desk</div>
    <h1 style="margin:4px 0 16px;font-size:22px">Daily recap — ${esc(today)}</h1>
    <table style="border-collapse:separate;border-spacing:8px 0;margin-left:-8px"><tr>
      ${stat("Open tickets", open.length)}
      ${stat("High", byPriority("High").length, "#dc2626")}
      ${stat("New (24h)", newCount)}
      ${stat("Resolved (24h)", resolvedCount, "#15803d")}
    </tr></table>
    ${locLine ? `<p style="font-size:13px;color:#334155;margin:16px 0 0">Open by location: ${locLine}</p>` : ""}
    ${open.length ? sections : `<p style="margin-top:24px">No open tickets. 🎉</p>`}
    <p style="margin-top:28px"><a href="${esc(appUrl)}/#/admin"
      style="background:#1e3a5f;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open dashboard</a></p>
  </div></body></html>`;

  const high = byPriority("High").length;
  const subject = `Help Desk recap: ${open.length} open${high ? ` (${high} high)` : ""}, ${newCount} new`;
  return { subject, html };
}

async function sendMail(subject: string, html: string) {
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: env("MS_MAILER_CLIENT_ID"),
        client_secret: env("MS_MAILER_CLIENT_SECRET"),
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  const token = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`Microsoft token error: ${token.error_description ?? tokenRes.status}`);

  const to = env("RECAP_TO").split(",").map((a) => a.trim()).filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env("RECAP_FROM"))}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { subject, body: { contentType: "HTML", content: html }, toRecipients: to },
        saveToSentItems: false,
      }),
    },
  );
  if (!res.ok) throw new Error(`Graph sendMail failed (${res.status}): ${await res.text()}`);
}

Deno.serve(async (req) => {
  try {
    if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
      return json({ error: "Unauthorized" }, 401);
    }
    const force = new URL(req.url).searchParams.get("force") === "1";
    const hour = easternHour();
    if (!force && hour !== 5) return json({ skipped: true, easternHour: hour });

    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

    const [open, created, resolved] = await Promise.all([
      db.from("tickets")
        .select("id,created_at,location,category,priority,status,title,requester_name,is_sale,sale_number")
        .neq("status", "Resolved")
        .order("created_at", { ascending: true }),
      db.from("tickets").select("id", { count: "exact", head: true }).gte("created_at", since),
      db.from("tickets").select("id", { count: "exact", head: true }).gte("resolved_at", since),
    ]);
    for (const r of [open, created, resolved]) if (r.error) throw r.error;

    const appUrl = env("APP_URL").replace(/\/+$/, "");
    const { subject, html } = buildEmail(open.data as Ticket[], created.count ?? 0, resolved.count ?? 0, appUrl);
    await sendMail(subject, html);
    return json({ sent: true, open: open.data!.length });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
