// 1915 South Help Desk — single-page app (no build step).
import { CONFIG } from "./config.js";

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------
const LOCATIONS = [
  "1201 Greensboro",
  "1202 Winston Salem",
  "1203 Burlington",
  "1204 Danville",
  "1205 Greensboro Outlet",
  "DC",
];
const CATEGORIES = [
  { value: "Question", hint: "How do I…?" },
  { value: "Problem", hint: "Something isn't working" },
  { value: "Request", hint: "I need something" },
];
const PRIORITIES = [
  { value: "Low", hint: "Whenever you can" },
  { value: "Medium", hint: "Soon — it's slowing me down" },
  { value: "High", hint: "Urgent — can't work / customer waiting" },
];
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const STATUSES = ["Open", "In Progress", "Resolved"];
const MAX_PHOTOS = 5;
const TZ = "America/New_York";

// ---------------------------------------------------------------------
// Data layer (Supabase, or an in-memory demo when ?demo is in the URL)
// ---------------------------------------------------------------------
const DEMO = new URLSearchParams(location.search).has("demo");
const api = DEMO ? (await import("./demo.js")).createDemoApi() : await createSupabaseApi();

async function createSupabaseApi() {
  if (CONFIG.SUPABASE_URL.includes("YOUR-")) return null;
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(CONFIG.SUPABASE_URL.trim())) {
    return { configError: `SUPABASE_URL in docs/config.js should look like https://abcdefghijklmnop.supabase.co — it's currently "${CONFIG.SUPABASE_URL}". The sb_publishable_… key belongs in SUPABASE_ANON_KEY instead.` };
  }
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
  });
  const ok = ({ data, error }) => { if (error) throw error; return data; };

  return {
    onAuthChange: (cb) => sb.auth.onAuthStateChange((_e, session) => setTimeout(() => cb(session), 0)),
    // Email + password. Accounts are created by an admin (Employees page); self-signup is off.
    signIn: async (email, password) => ok(await sb.auth.signInWithPassword({ email, password })),
    changePassword: async (password) => {
      ok(await sb.auth.updateUser({ password }));
      ok(await sb.rpc("mark_password_changed"));
    },
    // Admin-only actions run in the "admin-users" Edge Function (it holds the key that can create accounts).
    adminUsers: async (action, payload = {}) => {
      const { data, error } = await sb.functions.invoke("admin-users", { body: { action, ...payload } });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch {}
        if (/failed to send|not found|404/i.test(msg)) msg = "The admin-users function isn't set up yet (see SETUP.md).";
        throw new Error(msg);
      }
      return data;
    },
    signOut: () => sb.auth.signOut(),
    getProfile: async (uid) => ok(await sb.from("profiles").select("*").eq("id", uid).maybeSingle()),
    updateProfile: async (uid, patch) =>
      ok(await sb.from("profiles").update(patch).eq("id", uid).select().single()),
    listTickets: async ({ mineOnly, uid, statuses }) => {
      let q = sb.from("tickets").select("*").order("created_at", { ascending: false }).limit(1000);
      if (mineOnly) q = q.eq("created_by", uid);
      if (statuses) q = q.in("status", statuses);
      return ok(await q);
    },
    getTicket: async (id) => ok(await sb.from("tickets").select("*").eq("id", id).maybeSingle()),
    createTicket: async (t) => ok(await sb.from("tickets").insert(t).select().single()),
    updateTicket: async (id, patch) => ok(await sb.from("tickets").update(patch).eq("id", id).select().single()),
    listComments: async (id) =>
      ok(await sb.from("ticket_comments").select("*").eq("ticket_id", id).order("created_at")),
    addComment: async (ticket_id, body) =>
      ok(await sb.from("ticket_comments").insert({ ticket_id, body }).select().single()),
    listPhotos: async (id) => {
      const rows = ok(await sb.from("ticket_photos").select("path").eq("ticket_id", id).order("created_at"));
      if (!rows.length) return [];
      const signed = ok(await sb.storage.from("ticket-photos").createSignedUrls(rows.map((r) => r.path), 3600));
      return signed.map((s) => s.signedUrl).filter(Boolean);
    },
    addPhoto: async (ticketId, blob) => {
      const path = `${ticketId}/${crypto.randomUUID()}.jpg`;
      ok(await sb.storage.from("ticket-photos").upload(path, blob, { contentType: blob.type || "image/jpeg" }));
      ok(await sb.from("ticket_photos").insert({ ticket_id: ticketId, path }));
    },
    // handlers: { ticketInsert, ticketUpdate, commentInsert }, filter: optional ticket id
    subscribe: (name, handlers, ticketId) => {
      const ch = sb.channel(name);
      const f = (col) => (ticketId ? { filter: `${col}=eq.${ticketId}` } : {});
      if (handlers.ticketInsert)
        ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "tickets" }, (p) => handlers.ticketInsert(p.new));
      if (handlers.ticketUpdate)
        ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "tickets", ...f("id") }, (p) => handlers.ticketUpdate(p.new));
      if (handlers.commentInsert)
        ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "ticket_comments", ...f("ticket_id") }, (p) => handlers.commentInsert(p.new));
      ch.subscribe((status) => handlers.status?.(status));
      return () => sb.removeChannel(ch);
    },
  };
}

// ---------------------------------------------------------------------
// Tiny DOM helper — all user text goes through textContent (no innerHTML)
// ---------------------------------------------------------------------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const props = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "value" || k === "checked") props[k] = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  Object.assign(el, props);
  return el;
}
const svg = (markup) => { const s = h("span", { class: "icon", "aria-hidden": "true" }); s.innerHTML = markup; return s; };
const ICONS = {
  camera: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  device: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>',
};

// ---------------------------------------------------------------------
// Light / dark theme (remembered per device; "system" follows the iPad setting)
// ---------------------------------------------------------------------
const THEME_KEY = "helpdesk.theme";
const THEMES = [
  { value: "system", label: "System", icon: "device" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let themePref = (() => {
  try { const t = localStorage.getItem(THEME_KEY); return t === "light" || t === "dark" ? t : "system"; }
  catch { return "system"; }
})();
const isDark = () => themePref === "dark" || (themePref === "system" && darkQuery.matches);

function setTheme(t) {
  themePref = t;
  try { t === "system" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, t); } catch {}
  applyTheme();
}
function applyTheme() {
  const html = document.documentElement;
  if (themePref === "system") delete html.dataset.theme;
  else html.dataset.theme = themePref;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", isDark() ? "#0b1626" : "#1e3a5f");
  const btn = document.getElementById("theme-btn");
  if (btn) {
    const label = isDark() ? "Switch to light mode" : "Switch to dark mode";
    btn.replaceChildren(svg(isDark() ? ICONS.sun : ICONS.moon));
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
  document.querySelectorAll("[data-theme-choice]").forEach((b) => {
    const on = b.dataset.themeChoice === themePref;
    b.classList.toggle("selected", on);
    b.setAttribute("aria-pressed", String(on));
  });
}
darkQuery.addEventListener?.("change", applyTheme);
applyTheme();

function themeButton() {
  const btn = h("button", { type: "button", id: "theme-btn", class: "theme-btn",
    onclick: () => setTheme(isDark() ? "light" : "dark") });
  queueMicrotask(applyTheme); // fill in icon once it's in the page
  return btn;
}

// ---------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------
const digitsOnly = (s) => String(s || "").replace(/\D/g, "");
function fmtPhone(s) {
  const d = digitsOnly(s).slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
const fmtDate = (iso) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const slug = (s) => s.toLowerCase().replace(/\s+/g, "-");
const priorityBadge = (p) => h("span", { class: `badge prio prio-${slug(p)}` }, h("span", { class: "dot" }), p);
const statusBadge = (s) => h("span", { class: `badge status status-${slug(s)}` }, s);
const firstName = (name) => String(name || "").split(" ")[0];

// ---------------------------------------------------------------------
// Toasts, sound, notifications
// ---------------------------------------------------------------------
function toast(message, { type = "info", detail, onClick, timeout = 5000 } = {}) {
  const el = h("div", { class: `toast toast-${type}${onClick ? " clickable" : ""}`, role: "status" },
    h("div", { class: "toast-title" }, message),
    detail && h("div", { class: "toast-detail" }, detail));
  if (onClick) el.addEventListener("click", () => { onClick(); el.remove(); });
  document.getElementById("toasts").append(el);
  setTimeout(() => el.classList.add("leaving"), timeout);
  setTimeout(() => el.remove(), timeout + 400);
}

let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { /* no audio available */ }
}
document.addEventListener("pointerdown", unlockAudio);
function chime(priority) {
  if (!audioCtx || audioCtx.state !== "running") return;
  const notes = priority === "High" ? [880, 1175, 880, 1175] : [660, 880];
  notes.forEach((freq, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    const t = audioCtx.currentTime + i * 0.16;
    o.frequency.value = freq; o.type = "sine";
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.16);
  });
}

let unseen = 0;
function bumpTitle() { unseen++; document.title = `(${unseen}) Help Desk`; }
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { unseen = 0; document.title = "Help Desk"; state.onResume?.(); }
});

function alertAdmin(title, detail, hash, priority) {
  chime(priority);
  toast(title, { type: priority === "High" ? "danger" : "info", detail, onClick: () => (location.hash = hash), timeout: 10000 });
  if (document.hidden) bumpTitle();
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body: detail, tag: hash });
      n.onclick = () => { window.focus(); location.hash = hash; n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
}

// ---------------------------------------------------------------------
// App state & boot
// ---------------------------------------------------------------------
const root = document.getElementById("app");
const state = {
  session: null,
  profile: null,
  loadingProfile: false,
  cleanup: [],            // per-view teardown (realtime channels, timers)
  adminUnsub: null,
  liveStatus: "connecting",
  onTicketsChanged: null, // set by the admin dashboard
  onResume: null,
};

function clearView() {
  state.cleanup.forEach((fn) => { try { fn(); } catch {} });
  state.cleanup = [];
  state.onTicketsChanged = null;
  state.onResume = null;
}

function boot() {
  if (!api) return renderNotConfigured();
  if (api.configError) return renderNotConfigured(api.configError);
  const err = readAuthError();
  if (err) renderLogin(err);
  api.onAuthChange(handleSession);
  window.addEventListener("hashchange", route);
}

function readAuthError() {
  const params = new URLSearchParams(location.search + "&" + location.hash.replace(/^#\/?/, ""));
  const desc = params.get("error_description");
  if (!desc) return null;
  history.replaceState(null, "", location.pathname);
  return /database error|1915south/i.test(desc)
    ? `Please sign in with your @${CONFIG.COMPANY_DOMAIN} account.`
    : desc;
}

async function handleSession(session) {
  if (!session) {
    state.session = null; state.profile = null;
    state.adminUnsub?.(); state.adminUnsub = null;
    clearView();
    if (!root.querySelector(".login")) renderLogin();
    return;
  }
  const sameUser = state.session?.user?.id === session.user.id;
  state.session = session;
  if (sameUser && state.profile) return; // token refresh
  if (state.loadingProfile) return;
  state.loadingProfile = true;
  try {
    const email = (session.user.email || "").toLowerCase();
    if (!email.endsWith("@" + CONFIG.COMPANY_DOMAIN)) {
      await api.signOut();
      return renderLogin(`Please sign in with your @${CONFIG.COMPANY_DOMAIN} account.`);
    }
    const profile = await api.getProfile(session.user.id);
    if (!profile) throw new Error("Your profile wasn't created. Ask the help desk admin.");
    if (profile.disabled) {
      await api.signOut();
      return renderLogin("Your Help Desk access has been turned off. Contact the help desk admin.");
    }
    state.profile = profile;
    if (profile.is_admin) startAdminAlerts();
    const home = profile.is_admin ? "#/admin" : "#/new";
    go(!location.hash || location.hash === "#" || location.hash === "#/" ? home : location.hash);
  } catch (e) {
    renderError(e);
  } finally {
    state.loadingProfile = false;
  }
}

// Navigate, re-rendering even if we're already on that hash.
function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  if (!state.profile) return;
  // First sign-in: choose a password, then name + home location.
  if (state.profile.must_change_password) return renderChangePassword();
  if (!state.profile.home_location) return renderSetup(true);
  clearView();
  state.navSeq = (state.navSeq || 0) + 1;
  window.scrollTo(0, 0);
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const isAdmin = state.profile.is_admin;
  switch (parts[0]) {
    case "new": return viewNewTicket();
    case "mine": return viewMyTickets();
    case "ticket": return viewTicket(Number(parts[1]));
    case "settings": return renderSetup(false);
    case "employees": if (isAdmin) return viewEmployees(); // falls through for non-admins
    case "admin": if (isAdmin) return viewAdmin(); // falls through for non-admins
    default: location.hash = isAdmin ? "#/admin" : "#/new";
  }
}

// ---------------------------------------------------------------------
// Admin live alerts (active anywhere in the app while signed in as admin)
// ---------------------------------------------------------------------
function startAdminAlerts() {
  state.adminUnsub?.();
  state.adminUnsub = api.subscribe("admin-alerts", {
    ticketInsert: (t) => {
      alertAdmin(`New ${t.priority.toLowerCase()} priority ${t.category.toLowerCase()} · #${t.id}`,
        `${t.requester_name || "Someone"} · ${t.location}: ${t.title}`, `#/ticket/${t.id}`, t.priority);
      state.onTicketsChanged?.();
    },
    ticketUpdate: () => state.onTicketsChanged?.(),
    commentInsert: (c) => {
      if (c.author_is_admin) return;
      alertAdmin(`New reply on #${c.ticket_id}`, `${c.author_name}: ${c.body.slice(0, 140)}`, `#/ticket/${c.ticket_id}`);
    },
    status: (s) => { state.liveStatus = s; updateLiveDot(); },
  });
}
function updateLiveDot() {
  const el = document.getElementById("live-dot");
  if (!el) return;
  const live = state.liveStatus === "SUBSCRIBED";
  el.className = `live ${live ? "on" : "off"}`;
  el.title = live ? "Live: new tickets appear instantly" : "Reconnecting…";
  el.lastChild.textContent = live ? "Live" : "Offline";
}

// ---------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------
function shell(active, ...content) {
  const p = state.profile;
  const link = (hash, label, key) => h("a", { href: hash, class: `nav-link${active === key ? " active" : ""}` }, label);
  const header = h("header", { class: "topbar" },
    h("a", { class: "brand", href: p.is_admin ? "#/admin" : "#/new" },
      h("img", { src: "icons/icon-192.png", alt: "" }), h("span", {}, "Help Desk")),
    h("nav", { class: "nav" },
      p.is_admin && link("#/admin", "Dashboard", "admin"),
      link("#/new", "New Ticket", "new"),
      link("#/mine", "My Tickets", "mine"),
      p.is_admin && link("#/employees", "Employees", "employees")),
    h("div", { class: "topbar-right" },
      p.is_admin && h("span", { id: "live-dot", class: "live off" }, h("span", { class: "pulse" }), "…"),
      themeButton(),
      h("a", { href: "#/settings", class: `user-chip${active === "settings" ? " active" : ""}`, title: "Settings" },
        h("span", { class: "avatar" }, (p.full_name || p.email)[0].toUpperCase()),
        h("span", { class: "user-name" }, firstName(p.full_name) || p.email))));
  root.replaceChildren(header, h("main", { class: "page" }, ...content));
  updateLiveDot();
}

const LAST_EMAIL_KEY = "helpdesk.lastEmail";
const DOMAIN = CONFIG.COMPANY_DOMAIN;

function friendlyAuthError(err) {
  const m = err?.message || String(err);
  if (/invalid login credentials/i.test(m)) return "That email and password don't match. Check for typos, or ask the help desk admin to reset your password.";
  if (/banned/i.test(m)) return "Your Help Desk access has been turned off. Contact the help desk admin.";
  if (/rate limit|too many|security purposes/i.test(m)) return "Too many tries. Please wait a few minutes and try again.";
  if (/different from the old/i.test(m)) return "Choose a password that's different from your starting password.";
  if (/failed to fetch|network/i.test(m)) return "Can't reach the Help Desk. Check your Wi-Fi and try again.";
  return m;
}

function loginCard(...content) {
  root.replaceChildren(h("div", { class: "login" }, h("div", { class: "login-card" },
    h("img", { class: "login-logo", src: "icons/icon-192.png", alt: "" }),
    h("h1", {}, "1915 South Help Desk"),
    ...content)));
}

// sam.taylor@1915south.com → "Sam Taylor" (same rule the database uses)
const guessName = (email) => String(email).split("@")[0].split(/[._-]+/).filter(Boolean)
  .map((s) => s[0].toUpperCase() + s.slice(1)).join(" ");
const normalizeEmail = (v) => {
  const s = String(v || "").trim().toLowerCase();
  return s && !s.includes("@") ? `${s}@${DOMAIN}` : s;
};

// Password box with a Show/Hide toggle (typing passwords on an iPad is error-prone)
function passwordInput(attrs) {
  const input = h("input", { class: "input", type: "password", autocapitalize: "off", spellcheck: "false", ...attrs });
  const toggle = h("button", { type: "button", class: "pw-toggle", "aria-label": "Show password",
    onclick: () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Hide" : "Show";
      toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    } }, "Show");
  return { input, el: h("div", { class: "pw-wrap" }, input, toggle) };
}

function renderLogin(message) {
  let saved = "";
  try { saved = localStorage.getItem(LAST_EMAIL_KEY) || ""; } catch {}
  const email = h("input", { class: "input", type: "email", inputmode: "email", autocomplete: "username",
    autocapitalize: "off", spellcheck: "false", placeholder: `yourname@${DOMAIN}`, value: saved });
  const pw = passwordInput({ autocomplete: "current-password", placeholder: "Password" });
  const err = h("p", { class: "form-error" }, message || "");
  const btn = h("button", { class: "btn btn-primary btn-lg", type: "submit" }, "Sign in");
  const form = h("form", { class: "login-form", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const addr = normalizeEmail(email.value);
    if (!addr.endsWith("@" + DOMAIN)) { err.textContent = `Use your @${DOMAIN} email address.`; return; }
    if (!pw.input.value) { err.textContent = "Enter your password."; pw.input.focus(); return; }
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      await api.signIn(addr, pw.input.value); // success fires onAuthChange → app loads
      try { localStorage.setItem(LAST_EMAIL_KEY, addr); } catch {}
    } catch (x) {
      err.textContent = friendlyAuthError(x);
      btn.disabled = false; btn.textContent = "Sign in";
    }
  } },
    h("label", { class: "label" }, "Work email", email),
    h("label", { class: "label" }, "Password", pw.el),
    err, btn);
  loginCard(
    h("p", { class: "muted" }, `Sign in with your @${DOMAIN} email and password.`),
    form,
    h("p", { class: "fine" }, "First time? Use the starting password from your manager. ",
      "Forgot your password? Ask the help desk admin to reset it."));
  (saved ? pw.input : email).focus();
}

// Choose-a-password form, used on first sign-in and in Settings.
function passwordForm({ submitLabel, onDone }) {
  const pw1 = passwordInput({ autocomplete: "new-password", placeholder: "At least 8 characters" });
  const pw2 = passwordInput({ autocomplete: "new-password", placeholder: "Type it again" });
  const err = h("p", { class: "form-error" });
  const btn = h("button", { class: "btn btn-primary btn-lg", type: "submit" }, submitLabel);
  return h("form", { class: "login-form", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const a = pw1.input.value, b = pw2.input.value;
    if (a.length < 8) { err.textContent = "Use at least 8 characters."; pw1.input.focus(); return; }
    if (a !== b) { err.textContent = "The two passwords don't match."; pw2.input.focus(); return; }
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await api.changePassword(a);
      state.profile.must_change_password = false;
      onDone();
    } catch (x) {
      err.textContent = friendlyAuthError(x);
      btn.disabled = false; btn.textContent = submitLabel;
    }
  } },
    h("label", { class: "label" }, "New password", pw1.el),
    h("label", { class: "label" }, "Confirm new password", pw2.el),
    err, btn);
}

function renderChangePassword() {
  clearView();
  const form = passwordForm({
    submitLabel: "Save password",
    onDone: () => { toast("Password saved", { type: "success" }); route(); },
  });
  root.replaceChildren(h("div", { class: "login" }, h("div", { class: "login-card" },
    h("img", { class: "login-logo", src: "icons/icon-192.png", alt: "" }),
    h("h1", {}, "Choose your password"),
    h("p", { class: "muted" }, "Replace your starting password with one only you know. You'll use it if you ever need to sign in again."),
    form,
    h("p", { class: "fine" }, `Signed in as ${state.profile.email} · `,
      h("button", { class: "btn-link inline", type: "button", onclick: () => api.signOut() }, "Not you?")))));
  form.querySelector("input").focus();
}

function renderNotConfigured(problem) {
  root.replaceChildren(h("div", { class: "login" }, h("div", { class: "login-card" },
    h("h1", {}, problem ? "Setup needs a fix" : "Almost there"),
    problem
      ? h("p", { class: "form-error" }, problem)
      : h("p", {}, "Open docs/config.js and fill in your Supabase URL and key (see SETUP.md, step 2)."),
    h("p", { class: "fine" }, "Want to look around first? ", h("a", { href: "?demo" }, "Open the demo")))));
}

function renderError(e) {
  console.error(e);
  root.replaceChildren(h("div", { class: "login" }, h("div", { class: "login-card" },
    h("h1", {}, "Something went wrong"),
    h("p", { class: "form-error" }, e?.message || String(e)),
    h("button", { class: "btn", onclick: () => location.reload() }, "Try again"),
    h("button", { class: "btn btn-link", onclick: () => api.signOut() }, "Sign out"))));
}

// ---------------------------------------------------------------------
// Home location setup / settings
// ---------------------------------------------------------------------
function renderSetup(firstTime) {
  clearView();
  let chosen = state.profile.home_location;
  const nameInput = h("input", { class: "input", autocomplete: "name", maxlength: "80",
    placeholder: "First and last name", value: state.profile.full_name || "" });
  const nameErr = h("div", { class: "field-error" });
  const options = LOCATIONS.map((loc) =>
    h("button", {
      type: "button", class: `choice${loc === chosen ? " selected" : ""}`, "aria-pressed": String(loc === chosen),
      onclick: (e) => {
        chosen = loc;
        options.forEach((b) => { const on = b === e.currentTarget; b.classList.toggle("selected", on); b.setAttribute("aria-pressed", String(on)); });
        save.disabled = false;
      },
    }, loc));
  const save = h("button", {
    class: "btn btn-primary btn-lg", disabled: !chosen,
    onclick: async () => {
      const full_name = nameInput.value.trim().replace(/\s+/g, " ");
      nameErr.textContent = "";
      if (full_name.length < 2) { nameErr.textContent = "Enter your name so the help desk knows who you are."; nameInput.focus(); return; }
      save.disabled = true;
      try {
        state.profile = await api.updateProfile(state.profile.id, { full_name, home_location: chosen });
        toast(firstTime ? `Welcome, ${firstName(full_name)}!` : "Settings saved", { type: "success" });
        go(state.profile.is_admin ? "#/admin" : "#/new");
      } catch (e) { toast("Couldn't save", { type: "danger", detail: e.message }); save.disabled = false; }
    },
  }, firstTime ? "Continue" : "Save");

  const card = h("section", { class: "card narrow" },
    h("h1", {}, firstTime ? "Welcome!" : "Settings"),
    firstTime && h("p", { class: "muted" }, "Two quick things and you're set."),
    h("div", { class: "field" }, h("label", { class: "label" }, "Your name", nameInput), nameErr),
    h("div", { class: "label" }, "Home location"),
    h("p", { class: "muted small" }, "Where you usually work. It's filled in on your tickets, and you can still change it on any ticket."),
    h("div", { class: "choice-grid" }, options),
    h("div", { class: "actions" }, save),
    !firstTime && h("hr"),
    !firstTime && h("h2", {}, "Appearance"),
    !firstTime && h("p", { class: "muted small" }, "System matches your iPad's light/dark setting. Saved on this device."),
    !firstTime && h("div", { class: "choice-grid three", role: "group", "aria-label": "Appearance" },
      THEMES.map((t) => h("button", { type: "button", class: "choice", "data-theme-choice": t.value,
        onclick: () => setTheme(t.value) }, svg(ICONS[t.icon]), t.label))),
    !firstTime && h("hr"),
    !firstTime && h("h2", {}, "Change password"),
    !firstTime && passwordForm({
      submitLabel: "Change password",
      onDone: () => { toast("Password changed", { type: "success" }); renderSetup(false); },
    }),
    !firstTime && h("hr"),
    !firstTime && h("p", { class: "muted small" }, `Signed in as ${state.profile.email}`),
    !firstTime && h("button", { class: "btn btn-link danger", onclick: () => api.signOut() }, "Sign out"),
    firstTime && h("p", { class: "muted small" }, `Signed in as ${state.profile.email} · `,
      h("button", { class: "btn-link inline", type: "button", onclick: () => api.signOut() }, "Not you?")));

  if (firstTime) root.replaceChildren(h("main", { class: "page" }, card));
  else shell("settings", card);
}

// ---------------------------------------------------------------------
// New ticket
// ---------------------------------------------------------------------
function segmented(name, options, onChange, extraClass = "") {
  const buttons = options.map((o) =>
    h("button", {
      type: "button", class: `seg ${extraClass} ${extraClass ? `${extraClass}-${slug(o.value)}` : ""}`, "aria-pressed": "false",
      onclick: () => {
        buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === o.value)));
        onChange(o.value);
      },
      "data-value": o.value,
    }, h("span", { class: "seg-label" }, extraClass && h("span", { class: "dot" }), o.value), h("span", { class: "seg-hint" }, o.hint)));
  return h("div", { class: "segmented", role: "group", "aria-label": name }, buttons);
}

function field(label, control, { hint, error } = {}) {
  return h("div", { class: "field" }, h("label", { class: "label" }, label, control), hint && h("div", { class: "hint" }, hint), error);
}

function viewNewTicket() {
  const form = { location: state.profile.home_location, category: null, priority: null, is_sale: false, photos: [] };
  const errEl = (key) => h("div", { class: "field-error", "data-err": key });

  const locSel = h("select", { class: "input", onchange: (e) => (form.location = e.target.value), value: form.location },
    LOCATIONS.map((l) => h("option", { value: l }, l)));
  const title = h("input", { class: "input", maxlength: "200", placeholder: "Short summary, e.g. “Register 2 won't print receipts”" });
  const desc = h("textarea", { class: "input", rows: "5", maxlength: "5000", placeholder: "What happened? What have you tried? Anything we should know?" });

  // Sale section
  const custName = h("input", { class: "input", autocomplete: "off", placeholder: "First and last name" });
  const custPhone = h("input", { class: "input", type: "tel", inputmode: "numeric", placeholder: "(336) 555-0123",
    oninput: (e) => (e.target.value = fmtPhone(e.target.value)) });
  const saleNo = h("input", { class: "input", autocomplete: "off", placeholder: "Sale / order number" });
  const saleBox = h("div", { class: "sale-fields", hidden: true },
    field("Customer name *", custName, { error: errEl("customer_name") }),
    field("Customer phone *", custPhone, { error: errEl("customer_phone") }),
    field("Sale number *", saleNo, { error: errEl("sale_number") }));
  const saleCheck = h("input", { type: "checkbox", class: "checkbox",
    onchange: (e) => { form.is_sale = e.target.checked; saleBox.hidden = !form.is_sale; if (form.is_sale) custName.focus(); } });

  // Photos
  const thumbs = h("div", { class: "thumbs" });
  const fileInput = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true,
    onchange: (e) => {
      for (const f of e.target.files) if (form.photos.length < MAX_PHOTOS) form.photos.push(f);
      if (e.target.files.length && form.photos.length >= MAX_PHOTOS) toast(`Up to ${MAX_PHOTOS} photos per ticket`);
      e.target.value = "";
      drawThumbs();
    } });
  const addPhotoBtn = h("button", { type: "button", class: "btn photo-btn", onclick: () => fileInput.click() }, svg(ICONS.camera), "Add photo");
  function drawThumbs() {
    thumbs.replaceChildren(...form.photos.map((file, i) => {
      const url = URL.createObjectURL(file);
      return h("div", { class: "thumb" }, h("img", { src: url, alt: "", onload: () => URL.revokeObjectURL(url) }),
        h("button", { type: "button", class: "thumb-x", "aria-label": "Remove photo",
          onclick: () => { form.photos.splice(i, 1); drawThumbs(); } }, "×"));
    }));
    addPhotoBtn.hidden = form.photos.length >= MAX_PHOTOS;
  }

  const submit = h("button", { type: "submit", class: "btn btn-primary btn-lg" }, "Submit ticket");
  const formEl = h("form", { class: "card ticket-form", novalidate: true, onsubmit: onSubmit },
    h("h1", {}, "New ticket"),
    field("Location", locSel, { error: errEl("location") }),
    h("div", { class: "field" }, h("div", { class: "label" }, "Category"),
      segmented("Category", CATEGORIES, (v) => (form.category = v)), errEl("category")),
    h("div", { class: "field" }, h("div", { class: "label" }, "Priority"),
      segmented("Priority", PRIORITIES, (v) => (form.priority = v), "prio-seg"), errEl("priority")),
    field("Subject", title, { error: errEl("title") }),
    field("Details", desc, { error: errEl("description") }),
    h("div", { class: "field sale-toggle" },
      h("label", { class: "check-row" }, saleCheck, h("span", {}, h("strong", {}, "Is this regarding a sale?"),
        h("span", { class: "hint" }, "Check if a customer purchase is involved"))),
      saleBox),
    h("div", { class: "field" }, h("div", { class: "label" }, "Photos ", h("span", { class: "muted small" }, `(optional, up to ${MAX_PHOTOS})`)),
      h("div", { class: "photo-row" }, thumbs, addPhotoBtn), fileInput),
    h("div", { class: "form-error", "data-err": "_form" }),
    h("div", { class: "actions" }, submit));

  async function onSubmit(e) {
    e.preventDefault();
    formEl.querySelectorAll("[data-err]").forEach((el) => (el.textContent = ""));
    const errors = {};
    const t = {
      location: form.location, category: form.category, priority: form.priority,
      title: title.value.trim(), description: desc.value.trim(), is_sale: form.is_sale,
    };
    if (!t.location) errors.location = "Choose a location.";
    if (!t.category) errors.category = "Choose a category.";
    if (!t.priority) errors.priority = "Choose a priority.";
    if (!t.title) errors.title = "Add a short subject.";
    if (!t.description) errors.description = "Describe the issue.";
    if (t.is_sale) {
      t.customer_name = custName.value.trim();
      t.customer_phone = digitsOnly(custPhone.value);
      t.sale_number = saleNo.value.trim();
      if (!t.customer_name) errors.customer_name = "Customer name is required for sales.";
      if (t.customer_phone.length !== 10) errors.customer_phone = "Enter a 10-digit phone number.";
      if (!t.sale_number) errors.sale_number = "Sale number is required.";
    }
    if (Object.keys(errors).length) {
      for (const [k, msg] of Object.entries(errors)) formEl.querySelector(`[data-err="${k}"]`).textContent = msg;
      formEl.querySelector(`[data-err="${Object.keys(errors)[0]}"]`).closest(".field")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    submit.disabled = true; submit.textContent = "Submitting…";
    try {
      const ticket = await api.createTicket(t);
      let failed = 0;
      for (const file of form.photos) {
        try { await api.addPhoto(ticket.id, await shrinkImage(file)); } catch (err) { console.error(err); failed++; }
      }
      toast(`Ticket #${ticket.id} submitted`, { type: "success", detail: "We'll follow up in the ticket thread." });
      if (failed) toast(`${failed} photo(s) didn't upload`, { type: "danger" });
      location.hash = `#/ticket/${ticket.id}`;
    } catch (err) {
      formEl.querySelector('[data-err="_form"]').textContent = `Couldn't submit: ${err.message}`;
      submit.disabled = false; submit.textContent = "Submit ticket";
    }
  }

  shell("new", formEl);
}

// Resize big iPad photos to ≤1600px JPEG before upload.
async function shrinkImage(file, max = 1600) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    URL.revokeObjectURL(url);
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
    return blob || file;
  } catch {
    return file;
  }
}

// ---------------------------------------------------------------------
// Ticket lists
// ---------------------------------------------------------------------
function ticketCard(t, { showRequester }) {
  return h("a", { href: `#/ticket/${t.id}`, class: `ticket-card prio-border-${slug(t.priority)}` },
    h("div", { class: "tc-top" },
      h("span", { class: "tc-id" }, `#${t.id}`),
      priorityBadge(t.priority), statusBadge(t.status),
      t.is_sale && h("span", { class: "badge sale" }, "Sale")),
    h("div", { class: "tc-title" }, t.title),
    h("div", { class: "tc-meta" },
      [t.category, t.location, showRequester && t.requester_name, timeAgo(t.created_at)].filter(Boolean).join(" · ")));
}

function viewMyTickets() {
  let tab = "active";
  let tickets = null;
  const list = h("div", { class: "ticket-list" }, h("div", { class: "spinner" }));
  const tabs = h("div", { class: "tabs" },
    [["active", "Open"], ["resolved", "Resolved"], ["all", "All"]].map(([k, label]) =>
      h("button", { type: "button", class: `tab${k === tab ? " active" : ""}`, "data-k": k,
        onclick: (e) => { tab = k; tabs.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.k === k)); draw(); } }, label)));

  function draw() {
    if (!tickets) return;
    const rows = tickets.filter((t) => tab === "all" || (tab === "resolved" ? t.status === "Resolved" : t.status !== "Resolved"));
    list.replaceChildren(...(rows.length ? rows.map((t) => ticketCard(t, {})) :
      [h("div", { class: "empty" }, tab === "resolved" ? "No resolved tickets yet." : "No open tickets. ",
        tab !== "resolved" && h("a", { href: "#/new" }, "Submit one"))]));
  }
  async function load() {
    try { tickets = await api.listTickets({ mineOnly: true, uid: state.profile.id }); draw(); }
    catch (e) { list.replaceChildren(h("div", { class: "form-error" }, e.message)); }
  }
  shell("mine", h("div", { class: "page-head" }, h("h1", {}, "My tickets"), h("a", { class: "btn btn-primary", href: "#/new" }, "+ New ticket")), tabs, list);
  load();
  state.onResume = load;
}

// ---------------------------------------------------------------------
// Admin dashboard
// ---------------------------------------------------------------------
const FILTER_KEY = "helpdesk.adminFilters";
function loadFilters() {
  const base = { status: "active", location: "", category: "", priority: "", q: "" };
  try { return { ...base, ...JSON.parse(localStorage.getItem(FILTER_KEY) || "{}"), q: "" }; } catch { return base; }
}
function saveFilters(f) { try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch {} }

function viewAdmin() {
  const f = loadFilters();
  let tickets = [];
  const tiles = h("div", { class: "tiles" });
  const body = h("div", { class: "admin-list" }, h("div", { class: "spinner" }));
  const countEl = h("span", { class: "muted small" });

  const sel = (key, label, opts) =>
    h("select", { class: "input input-sm", "aria-label": label, value: f[key],
      onchange: (e) => { f[key] = e.target.value; saveFilters(f); if (key === "status") load(); else draw(); } },
      opts.map(([v, l]) => h("option", { value: v }, l)));

  const statusSel = sel("status", "Status", [["active", "Open + In progress"], ["Open", "Open"], ["In Progress", "In progress"], ["Resolved", "Resolved"], ["all", "All statuses"]]);
  const locSel = sel("location", "Location", [["", "All locations"], ...LOCATIONS.map((l) => [l, l])]);
  const catSel = sel("category", "Category", [["", "All categories"], ...CATEGORIES.map((c) => [c.value, c.value])]);
  const prioSel = sel("priority", "Priority", [["", "All priorities"], ...PRIORITIES.map((p) => [p.value, p.value])]);
  const search = h("input", { class: "input input-sm search", type: "search", placeholder: "Search title, name, customer, sale #…",
    oninput: (e) => { f.q = e.target.value.toLowerCase(); draw(); } });

  const alertsBtn = h("button", { type: "button", class: "btn btn-sm", onclick: enableAlerts }, svg(ICONS.bell), "Test alerts");
  function enableAlerts() {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    setTimeout(() => alertAdmin("Alerts are on", "You'll hear a chime and see a pop-up for new tickets and replies while this app is open.", "#/admin", "Medium"), 150);
  }

  function draw() {
    const active = tickets.filter((t) => t.status !== "Resolved");
    tiles.replaceChildren(...PRIORITIES.slice().reverse().map((p) => {
      const n = active.filter((t) => t.priority === p.value).length;
      return h("button", { type: "button", class: `tile tile-${slug(p.value)}${f.priority === p.value ? " selected" : ""}`,
        onclick: () => { f.priority = f.priority === p.value ? "" : p.value; prioSel.value = f.priority; saveFilters(f); draw(); } },
        h("div", { class: "tile-n" }, n), h("div", { class: "tile-l" }, `${p.value} priority`));
    }), h("div", { class: "tile tile-total" }, h("div", { class: "tile-n" }, active.length), h("div", { class: "tile-l" }, "Open total")));

    // Location option labels with open counts
    [...locSel.options].forEach((o) => {
      if (!o.value) return;
      const n = active.filter((t) => t.location === o.value).length;
      o.textContent = n ? `${o.value} (${n})` : o.value;
    });

    const rows = tickets
      .filter((t) => !f.location || t.location === f.location)
      .filter((t) => !f.category || t.category === f.category)
      .filter((t) => !f.priority || t.priority === f.priority)
      .filter((t) => !f.q || [t.id, t.title, t.description, t.requester_name, t.customer_name, t.customer_phone, t.sale_number]
        .some((v) => String(v ?? "").toLowerCase().includes(f.q)))
      .sort((a, b) =>
        (a.status === "Resolved") - (b.status === "Resolved") ||
        (a.status === "Resolved" ? 0 : PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) ||
        new Date(b.created_at) - new Date(a.created_at));

    countEl.textContent = `${rows.length} ticket${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) return body.replaceChildren(h("div", { class: "empty" }, "No tickets match these filters."));

    const table = h("table", { class: "tickets-table" },
      h("thead", {}, h("tr", {}, ["#", "Priority", "Ticket", "Location", "From", "Status", "Age"].map((c) => h("th", {}, c)))),
      h("tbody", {}, rows.map((t) =>
        h("tr", { class: `row prio-row-${slug(t.priority)}`, tabindex: "0",
          onclick: () => (location.hash = `#/ticket/${t.id}`),
          onkeydown: (e) => { if (e.key === "Enter") location.hash = `#/ticket/${t.id}`; } },
          h("td", { class: "mono" }, `#${t.id}`),
          h("td", {}, priorityBadge(t.priority)),
          h("td", { class: "cell-title" }, h("div", {}, t.title),
            h("div", { class: "muted small" }, t.category, t.is_sale ? ` · Sale #${t.sale_number} · ${t.customer_name}` : "")),
          h("td", {}, t.location),
          h("td", {}, t.requester_name),
          h("td", {}, statusBadge(t.status)),
          h("td", { class: "muted", title: fmtDate(t.created_at) }, timeAgo(t.created_at))))));
    body.replaceChildren(table);
  }

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const statuses = f.status === "active" ? ["Open", "In Progress"] : f.status === "all" ? null : [f.status];
    try {
      const data = await api.listTickets({ statuses });
      if (seq !== loadSeq) return;
      tickets = data; draw();
    } catch (e) { body.replaceChildren(h("div", { class: "form-error" }, e.message)); }
  }

  shell("admin",
    h("div", { class: "page-head" }, h("h1", {}, "Dashboard"), alertsBtn),
    tiles,
    h("div", { class: "filters" }, search, statusSel, locSel, catSel, prioSel, countEl),
    h("div", { class: "card flush" }, body));
  load();
  state.onTicketsChanged = load;
  state.onResume = load;
  const tick = setInterval(draw, 60_000); // keep "age" fresh
  state.cleanup.push(() => clearInterval(tick));
}

// ---------------------------------------------------------------------
// Admin: Employees (add accounts, reset passwords, turn access off/on)
// ---------------------------------------------------------------------

// Accepts lines like "sam.taylor@1915south.com", "Dana Price, dana.price@1915south.com",
// "Dana Price <dana.price@…>", or just "sam.taylor".
function parsePeople(text) {
  const seen = new Set();
  const people = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/[^\s,;<>"]+@[^\s,;<>"]+/);
    let email, name;
    if (m) {
      email = m[0].toLowerCase();
      name = line.replace(m[0], "").replace(/[<>",;\t]/g, " ").replace(/\s+/g, " ").trim();
    } else if (/^[a-z0-9._-]+$/i.test(line)) {
      email = normalizeEmail(line); name = "";
    } else {
      people.push({ email: line, name: "", bad: true });
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    people.push({ email, name });
  }
  return people;
}

function viewEmployees() {
  const nav = state.navSeq;
  const siteUrl = location.origin + location.pathname;
  let users = [];
  let filter = "";

  const resultsArea = h("div");
  const listBody = h("div", {}, h("div", { class: "spinner" }));
  const countEl = h("span", { class: "muted small" });

  // ----- Add employees -----
  const textarea = h("textarea", { class: "input", rows: "6",
    placeholder: `One person per line, for example:\nsam.taylor@${DOMAIN}\nDana Price, dana.price@${DOMAIN}\nchris.lee` });
  const addErr = h("div", { class: "form-error" });
  const addBtn = h("button", { type: "button", class: "btn btn-primary", onclick: async () => {
    addErr.textContent = "";
    const people = parsePeople(textarea.value);
    const bad = people.filter((p) => p.bad || !p.email.endsWith("@" + DOMAIN));
    if (!people.length) { addErr.textContent = "Paste at least one email address."; return; }
    if (bad.length) { addErr.textContent = `These aren't @${DOMAIN} addresses: ${bad.map((p) => p.email).join(", ")}`; return; }
    addBtn.disabled = true; addBtn.textContent = `Adding ${people.length}…`;
    try {
      const { results } = await api.adminUsers("create", { people });
      showCredentials(results.filter((r) => r.status === "created"), results.filter((r) => r.status !== "created"));
      textarea.value = "";
      load();
    } catch (e) { addErr.textContent = e.message; }
    addBtn.disabled = false; addBtn.textContent = "Add employees";
  } }, "Add employees");

  // ----- Starting passwords (printable) -----
  function showCredentials(created, problems = [], heading = "New accounts") {
    const printBtn = h("button", { type: "button", class: "btn", onclick: () => {
      document.body.classList.add("print-slips");
      window.print();
      setTimeout(() => document.body.classList.remove("print-slips"), 500);
    } }, "Print sign-in slips");
    resultsArea.replaceChildren(h("section", { class: "card print-area" },
      h("div", { class: "page-head no-print" }, h("h2", {}, heading),
        h("div", { class: "row-actions" }, created.length > 0 && printBtn,
          h("button", { type: "button", class: "btn", onclick: () => resultsArea.replaceChildren() }, "Done"))),
      created.length > 0 && h("p", { class: "muted small no-print" },
        "Give each person their starting password (print the slips, or read it to them). This is the only time it's shown — they'll replace it the first time they sign in."),
      created.map((c) => h("div", { class: "slip" },
        h("div", { class: "slip-title" }, "1915 South Help Desk — sign-in"),
        h("div", { class: "slip-name" }, c.name || guessName(c.email)),
        h("dl", {},
          h("dt", {}, "Website"), h("dd", {}, siteUrl),
          h("dt", {}, "Email"), h("dd", { class: "mono" }, c.email),
          h("dt", {}, "Starting password"), h("dd", { class: "mono slip-pw" }, c.password)),
        h("div", { class: "slip-help" },
          "On your iPad: open the website in Safari → Share → Add to Home Screen. Open Help Desk from your Home Screen, sign in, then choose your own password."))),
      problems.length > 0 && h("div", { class: "no-print" },
        h("h2", {}, "Not added"),
        h("ul", {}, problems.map((p) => h("li", {}, h("span", { class: "mono" }, p.email), ` — ${p.message}`))))));
    resultsArea.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ----- Employee list -----
  function statusBadgeFor(u) {
    if (u.disabled) return h("span", { class: "badge status-resolved" }, "Access off");
    if (u.is_admin) return h("span", { class: "badge status-in-progress" }, "Admin");
    if (u.must_change_password) return h("span", { class: "badge prio-medium" }, "Hasn't signed in yet");
    return h("span", { class: "badge prio-low" }, "Active");
  }

  async function act(u, action) {
    const who = u.full_name || u.email;
    const prompts = {
      reset: `Give ${who} a new starting password? Their current password will stop working.`,
      disable: `Turn off Help Desk access for ${who}? They'll be signed out within an hour. Their tickets are kept.`,
      enable: `Turn Help Desk access back on for ${who}?`,
    };
    if (!confirm(prompts[action])) return;
    try {
      const res = await api.adminUsers(action, { user_id: u.id });
      if (action === "reset") showCredentials([{ ...res, name: who }], [], "New starting password");
      else toast(action === "disable" ? `Access turned off for ${who}` : `Access restored for ${who}`, { type: "success" });
      load();
    } catch (e) { toast("Couldn't do that", { type: "danger", detail: e.message }); }
  }

  function draw() {
    const rows = users.filter((u) => !filter ||
      [u.full_name, u.email, u.home_location].some((v) => String(v ?? "").toLowerCase().includes(filter)));
    countEl.textContent = `${users.filter((u) => !u.disabled).length} active · ${users.length} total`;
    if (!rows.length) return listBody.replaceChildren(h("div", { class: "empty" }, users.length ? "No one matches that search." : "No employees yet. Add some above."));
    listBody.replaceChildren(h("table", { class: "tickets-table people-table" },
      h("thead", {}, h("tr", {}, ["Name", "Home location", "Status", "Last sign-in", ""].map((c) => h("th", {}, c)))),
      h("tbody", {}, rows.map((u) => {
        const me = u.id === state.profile.id;
        return h("tr", { class: u.disabled ? "row-off" : "" },
          h("td", { class: "cell-title" }, h("div", {}, u.full_name || "—", me && h("span", { class: "muted small" }, " (you)")),
            h("div", { class: "muted small mono" }, u.email)),
          h("td", {}, u.home_location || h("span", { class: "muted" }, "—")),
          h("td", {}, statusBadgeFor(u)),
          h("td", { class: "muted" }, u.last_sign_in_at ? timeAgo(u.last_sign_in_at) : "Never"),
          h("td", { class: "row-actions" }, !me && [
            h("button", { type: "button", class: "btn btn-sm", onclick: () => act(u, "reset") }, "Reset password"),
            u.disabled
              ? h("button", { type: "button", class: "btn btn-sm", onclick: () => act(u, "enable") }, "Turn on")
              : h("button", { type: "button", class: "btn btn-sm btn-danger-outline", onclick: () => act(u, "disable") }, "Turn off"),
          ]));
      }))));
  }

  async function load() {
    try {
      const data = await api.adminUsers("list");
      if (nav !== state.navSeq) return;
      users = data.users; draw();
    } catch (e) { listBody.replaceChildren(h("div", { class: "form-error card-pad" }, e.message)); }
  }

  shell("employees",
    h("div", { class: "page-head no-print" }, h("h1", {}, "Employees")),
    h("section", { class: "card no-print" },
      h("h2", {}, "Add employees"),
      h("p", { class: "muted small" }, `Paste @${DOMAIN} email addresses, one per line. Add a name before the email if you'd like (otherwise it's guessed from the email, and they can fix it).`),
      textarea, addErr, h("div", { class: "actions" }, addBtn)),
    resultsArea,
    h("div", { class: "filters no-print" },
      h("input", { class: "input input-sm search", type: "search", placeholder: "Search name, email, location…",
        oninput: (e) => { filter = e.target.value.toLowerCase(); draw(); } }),
      countEl),
    h("div", { class: "card flush no-print" }, listBody));
  load();
}

// ---------------------------------------------------------------------
// Ticket detail + comment thread
// ---------------------------------------------------------------------
async function viewTicket(id) {
  const isAdmin = state.profile.is_admin;
  const nav = state.navSeq;
  shell(isAdmin ? "admin" : "mine", h("div", { class: "spinner" }));
  let ticket, comments, photos;
  try {
    [ticket, comments, photos] = await Promise.all([api.getTicket(id), api.listComments(id), api.listPhotos(id)]);
  } catch (e) {
    if (nav === state.navSeq) shell("mine", h("div", { class: "card" }, h("p", { class: "form-error" }, e.message)));
    return;
  }
  if (nav !== state.navSeq) return; // user navigated away while loading
  if (!ticket) return shell("mine", h("div", { class: "card" }, h("h1", {}, "Ticket not found"), h("a", { href: "#/mine" }, "Back to my tickets")));

  const seen = new Set(comments.map((c) => c.id));
  const thread = h("div", { class: "thread" });
  const commentEl = (c) => {
    const mine = c.author_id === state.profile.id;
    return h("div", { class: `msg${mine ? " mine" : ""}${c.author_is_admin ? " admin" : ""}` },
      h("div", { class: "msg-head" }, h("strong", {}, mine ? "You" : c.author_name || "Unknown"),
        c.author_is_admin && !mine && h("span", { class: "badge tiny" }, "Help Desk"),
        h("span", { class: "muted small" }, fmtDate(c.created_at))),
      h("div", { class: "msg-body" }, c.body));
  };
  const drawThread = () => thread.replaceChildren(...(comments.length ? comments.map(commentEl) : [h("div", { class: "empty small" }, "No replies yet.")]));
  drawThread();

  const reply = h("textarea", { class: "input", rows: "3", maxlength: "5000", placeholder: isAdmin ? "Reply to the employee…" : "Add a reply or more details…" });
  const sendBtn = h("button", { type: "submit", class: "btn btn-primary" }, "Send");
  const replyForm = h("form", { class: "reply", onsubmit: async (e) => {
    e.preventDefault();
    const body = reply.value.trim();
    if (!body) return;
    sendBtn.disabled = true;
    try {
      const c = await api.addComment(id, body);
      if (!seen.has(c.id)) { seen.add(c.id); comments.push(c); drawThread(); }
      reply.value = "";
    } catch (err) { toast("Couldn't send", { type: "danger", detail: err.message }); }
    sendBtn.disabled = false;
  } }, reply, h("div", { class: "actions" }, sendBtn));

  // Header + admin controls
  const head = h("div", { class: "detail-head" });
  function drawHead() {
    const controls = !isAdmin ? "" : h("div", { class: "admin-controls" },
      h("label", { class: "label-inline" }, "Status",
        h("select", { class: "input input-sm", value: ticket.status, onchange: (e) => patch({ status: e.target.value }) },
          STATUSES.map((s) => h("option", { value: s }, s)))),
      h("label", { class: "label-inline" }, "Priority",
        h("select", { class: `input input-sm prio-select prio-select-${slug(ticket.priority)}`, value: ticket.priority, onchange: (e) => patch({ priority: e.target.value }) },
          PRIORITIES.map((p) => h("option", { value: p.value }, p.value)))),
      ticket.status !== "Resolved" && h("button", { class: "btn btn-sm btn-success", onclick: () => patch({ status: "Resolved" }) }, "Mark resolved"));
    head.className = `detail-head card prio-border-${slug(ticket.priority)}`;
    head.replaceChildren(
      h("div", { class: "tc-top" }, h("span", { class: "tc-id" }, `#${ticket.id}`), priorityBadge(ticket.priority), statusBadge(ticket.status),
        h("span", { class: "badge" }, ticket.category), ticket.is_sale && h("span", { class: "badge sale" }, "Sale")),
      h("h1", { class: "detail-title" }, ticket.title),
      h("div", { class: "muted small" },
        `${ticket.requester_name || ""} · ${ticket.location} · ${fmtDate(ticket.created_at)}`,
        ticket.resolved_at ? ` · Resolved ${fmtDate(ticket.resolved_at)}` : ""),
      controls);
  }
  async function patch(p) {
    try { ticket = await api.updateTicket(id, p); drawHead(); toast("Updated", { type: "success", timeout: 2000 }); }
    catch (e) { toast("Couldn't update", { type: "danger", detail: e.message }); drawHead(); }
  }
  drawHead();

  const saleInfo = ticket.is_sale && h("div", { class: "sale-info" },
    h("h2", {}, "Sale details"),
    h("dl", {},
      h("dt", {}, "Customer"), h("dd", {}, ticket.customer_name),
      h("dt", {}, "Phone"), h("dd", {}, h("a", { href: `tel:${ticket.customer_phone}` }, fmtPhone(ticket.customer_phone))),
      h("dt", {}, "Sale #"), h("dd", { class: "mono" }, ticket.sale_number)));

  const gallery = photos.length > 0 && h("div", { class: "gallery" },
    photos.map((url) => h("a", { href: url, target: "_blank", rel: "noopener" }, h("img", { src: url, alt: "Attached photo", loading: "lazy" }))));

  shell(isAdmin ? "admin" : "mine",
    h("a", { class: "back", href: isAdmin ? "#/admin" : "#/mine" }, svg(ICONS.back), isAdmin ? "Dashboard" : "My tickets"),
    head,
    h("div", { class: "card" }, h("h2", {}, "Details"), h("p", { class: "pre" }, ticket.description), saleInfo, gallery),
    h("div", { class: "card" }, h("h2", {}, "Conversation"), thread, ticket.status === "Resolved" && !isAdmin
      ? h("p", { class: "muted small" }, "This ticket is resolved. Reply below if you still need help.") : null, replyForm));

  state.cleanup.push(api.subscribe(`ticket-${id}`, {
    commentInsert: (c) => {
      if (seen.has(c.id)) return;
      seen.add(c.id); comments.push(c); drawThread();
      if (!isAdmin && c.author_is_admin) { chime(); toast("New reply from the Help Desk", { type: "info" }); }
    },
    ticketUpdate: (t) => {
      const statusChanged = t.status !== ticket.status;
      ticket = { ...ticket, ...t }; drawHead();
      if (!isAdmin && statusChanged) toast(`Status changed to ${t.status}`);
    },
  }, id));
}

boot();
