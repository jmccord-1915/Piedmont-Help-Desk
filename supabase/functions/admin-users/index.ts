// Supabase Edge Function: admin-users
// Lets help desk admins add employees, reset passwords, and turn access off/on.
// Deploy from the Supabase dashboard (Edge Functions → Deploy a new function → Via Editor),
// name it exactly "admin-users", and leave "Verify JWT" ON.
// No secrets to add: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const DOMAIN = "1915south.com";
const MAX_PER_BATCH = 200;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Easy-to-read starting passwords like "Maple-River-4821". Employees replace them on first sign-in.
const WORDS = [
  "Amber", "Anchor", "Apple", "Arrow", "Aspen", "Badger", "Basil", "Beacon", "Birch", "Bison", "Blue", "Brook",
  "Cedar", "Cherry", "Clover", "Comet", "Copper", "Coral", "Crane", "Daisy", "Delta", "Eagle", "Ember", "Falcon",
  "Fern", "Field", "Flint", "Forest", "Garnet", "Ginger", "Granite", "Harbor", "Hazel", "Heron", "Hickory", "Indigo",
  "Iris", "Ivory", "Jade", "Juniper", "Kestrel", "Lake", "Lantern", "Laurel", "Lemon", "Lilac", "Linen", "Maple",
  "Meadow", "Mesa", "Mint", "Moss", "Nutmeg", "Oak", "Ocean", "Olive", "Orchid", "Otter", "Pebble", "Pepper",
  "Pine", "Plum", "Prairie", "Quartz", "Raven", "Reed", "Ridge", "River", "Robin", "Sage", "Spruce", "Stone",
  "Summit", "Sunset", "Thistle", "Tiger", "Topaz", "Tulip", "Valley", "Violet", "Walnut", "Willow", "Wren", "Zephyr",
];
function tempPassword(): string {
  const r = crypto.getRandomValues(new Uint32Array(3));
  return `${WORDS[r[0] % WORDS.length]}-${WORDS[r[1] % WORDS.length]}-${1000 + (r[2] % 9000)}`;
}

type Person = { email: string; name?: string };

async function listUsers(db: SupabaseClient) {
  const { data: profiles, error } = await db.from("profiles")
    .select("id,email,full_name,home_location,is_admin,must_change_password,disabled,created_at");
  if (error) throw error;
  const lastSignIn = new Map<string, string | null>();
  for (let page = 1; page < 50; page++) {
    const { data, error: e } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (e) throw e;
    for (const u of data.users) lastSignIn.set(u.id, u.last_sign_in_at ?? null);
    if (data.users.length < 1000) break;
  }
  return (profiles ?? [])
    .map((p) => ({ ...p, last_sign_in_at: lastSignIn.get(p.id) ?? null }))
    .sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
}

async function createUsers(db: SupabaseClient, people: Person[]) {
  if (!Array.isArray(people) || !people.length) throw new Error("No employees to add.");
  if (people.length > MAX_PER_BATCH) throw new Error(`Add at most ${MAX_PER_BATCH} at a time.`);
  const results = [];
  for (const p of people) {
    const email = String(p.email || "").trim().toLowerCase();
    const name = String(p.name || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !email.endsWith("@" + DOMAIN)) {
      results.push({ email, name, status: "invalid", message: `Not an @${DOMAIN} address` });
      continue;
    }
    const password = tempPassword();
    const { error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: name ? { full_name: name } : {},
    });
    if (error) {
      const exists = /already|registered|exists/i.test(error.message);
      results.push({ email, name, status: exists ? "exists" : "error", message: exists ? "Already has an account" : error.message });
    } else {
      results.push({ email, name, password, status: "created" });
    }
  }
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Who is calling? Must be a signed-in help desk admin.
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authErr } = await db.auth.getUser(jwt);
    if (authErr || !user) return json({ error: "Please sign in again." }, 401);
    const { data: me } = await db.from("profiles").select("is_admin").eq("id", user.id).single();
    if (!me?.is_admin) return json({ error: "Only help desk admins can manage employees." }, 403);

    const body = await req.json().catch(() => ({}));
    const targetId: string | undefined = body.user_id;
    if (["reset", "disable", "enable"].includes(body.action)) {
      if (!targetId) return json({ error: "Missing user_id" }, 400);
      if (targetId === user.id) {
        return json({ error: "You can't do that to your own account. Change your own password in Settings." }, 400);
      }
    }

    switch (body.action) {
      case "list":
        return json({ users: await listUsers(db) });

      case "create":
        return json({ results: await createUsers(db, body.people) });

      case "reset": {
        const password = tempPassword();
        const { data, error } = await db.auth.admin.updateUserById(targetId!, { password, ban_duration: "none" });
        if (error) throw error;
        await db.from("profiles").update({ must_change_password: true, disabled: false }).eq("id", targetId!);
        return json({ email: data.user.email, password });
      }

      case "disable": {
        // ~100 years. They're signed out within the hour (when their current session expires).
        const { error } = await db.auth.admin.updateUserById(targetId!, { ban_duration: "876000h" });
        if (error) throw error;
        await db.from("profiles").update({ disabled: true }).eq("id", targetId!);
        return json({ ok: true });
      }

      case "enable": {
        const { error } = await db.auth.admin.updateUserById(targetId!, { ban_duration: "none" });
        if (error) throw error;
        await db.from("profiles").update({ disabled: false }).eq("id", targetId!);
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
