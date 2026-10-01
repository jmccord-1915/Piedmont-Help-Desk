# 1915 South Help Desk — Setup Guide

Plan on about 45 minutes. Everything happens in your web browser — nothing to install.
The code lives in a GitHub repository, GitHub Pages hosts the website, and Supabase is the database.

**What's in this folder**

| Path | What it is |
|---|---|
| `docs/` | The website. GitHub Pages serves this folder. |
| `docs/config.js` | The only file you edit (2 values). |
| `supabase/01_schema.sql` | Creates the database, security rules, photo storage, live updates. |
| `supabase/functions/daily-recap/index.ts` | The 5 AM recap email. |
| `supabase/02_schedule_recap.sql` | Schedules that email. |

Throughout this guide, **`YOUR-SITE`** means your GitHub Pages address from step 1,
e.g. `https://1915south.github.io/helpdesk` (no trailing slash).

---

## 1. Put the code on GitHub and turn on GitHub Pages

1. Sign in at <https://github.com> (or create an account — an organization like `1915south` is a nice touch but optional).
2. Click **+ → New repository**.
   - Name: `helpdesk`
   - Visibility: **Public** — free GitHub Pages requires a public repo on free accounts.
     Nothing secret is in this code (the Supabase key in `config.js` is designed to be public; the
     database rules protect the data). If you'd rather keep it **Private**, you'll need GitHub Pro/Team.
   - Check **Add a README file**, then **Create repository**.
3. In the new repo: **Add file → Upload files**. Open the `helpdesk` folder on your PC, select
   **`docs`, `supabase`, `README.md` and `SETUP.md`**, and drag them all onto the page.
   Wait for the file list to finish, then click **Commit changes**.
   *(Upload the folders themselves, not the `helpdesk` folder — `docs` must be at the top level of the repo.)*
4. **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: **main**, folder: **/docs** → **Save**.
5. After a minute or two, the Pages screen shows **"Your site is live at …"** — that's `YOUR-SITE`.

Try it: open `YOUR-SITE/?demo` to click around with fake data (add `&as=employee` for the employee view).

> **Editing files later:** open the file on github.com → pencil icon ✏️ → make the change → **Commit changes**.
> The site updates itself in about a minute. Employees may need to close and reopen the app to see the change.

> **Optional — nicer address:** to use `helpdesk.1915south.com`, go to **Settings → Pages → Custom domain**,
> enter it, and add a DNS **CNAME** record `helpdesk` → `YOUR-GITHUB-NAME.github.io` wherever 1915south.com's DNS is managed.
> Then use that address everywhere this guide says `YOUR-SITE`.

## 2. Create the Supabase project (database)

1. Go to <https://supabase.com>, sign up, and click **New project**.
   - Name: `1915-helpdesk` · Region: **East US (North Virginia)** · save the database password somewhere safe.
2. When it finishes, go to **Project Settings → API Keys** (or **Data API**) and copy:
   - **Project URL** — looks like `https://abcdxyz.supabase.co` (the `abcdxyz` part is your *project ref*)
   - **anon / publishable key**
3. On GitHub, open **`docs/config.js`** → ✏️ → paste both values in place of the placeholders → **Commit changes**.

## 3. Create the database

1. In Supabase: **SQL Editor → New query**.
2. Open `supabase/01_schema.sql`, copy everything, paste, click **Run**. You should see "Success".

This makes you (`jmccord@1915south.com`) the admin automatically. To add another admin later, run:
```sql
insert into admin_emails values ('someone@1915south.com');
update profiles set is_admin = true where email = 'someone@1915south.com';
```

## 4. Register the sign-in app in Microsoft Entra

1. Go to <https://entra.microsoft.com> → **Applications → App registrations → New registration**.
   - Name: `1915 South Help Desk`
   - Supported account types: **Accounts in this organizational directory only (single tenant)** ← this is what limits sign-in to @1915south.com
   - Redirect URI: platform **Web**, value `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
   - Click **Register**.
2. On the Overview page copy the **Application (client) ID** and **Directory (tenant) ID**.
3. **Certificates & secrets → New client secret** → 24 months → copy the **Value** (not the ID). Put a calendar reminder to renew it before it expires.
4. **Token configuration → Add optional claim** → token type **ID** → check `email` and `xms_edov` → Add (accept the prompt to add the Microsoft Graph email permission).

## 5. Turn on Microsoft sign-in in Supabase

1. Supabase → **Authentication → Sign In / Providers → Azure** → enable.
2. Client ID = the Application (client) ID · Secret = the secret Value
3. Azure Tenant URL = `https://login.microsoftonline.com/YOUR-TENANT-ID`
4. Save.

## 6. Tell Supabase your website address

Supabase → **Authentication → URL Configuration**:
- Site URL: `YOUR-SITE/` (e.g. `https://1915south.github.io/helpdesk/`)
- Redirect URLs → Add: `YOUR-SITE/**` (e.g. `https://1915south.github.io/helpdesk/**`)

## 7. Test sign-in

Open `YOUR-SITE`, click **Sign in with Microsoft**, pick your home location. You should land on the Dashboard.
Submit a test ticket from **New Ticket** and watch it appear.

---

## 8. Daily recap email — register the mailer

A separate app registration that can only send email (kept apart from sign-in on purpose).

1. Entra → **App registrations → New registration** → Name `Help Desk Mailer`, single tenant, no redirect URI.
2. Copy its **Application (client) ID**. Create a **client secret** and copy the Value.
3. **API permissions → Add a permission → Microsoft Graph → Application permissions → `Mail.Send`** → Add.
4. Click **Grant admin consent for 1915 South**.

> **Recommended:** by default `Mail.Send` can send as *any* mailbox. To limit it to just your mailbox,
> run this once in Exchange Online PowerShell (replace the App ID):
> ```powershell
> New-ApplicationAccessPolicy -AppId <MAILER-CLIENT-ID> -PolicyScopeGroupId jmccord@1915south.com -AccessRight RestrictAccess -Description "Help Desk recap"
> ```

## 9. Deploy the recap function

1. Supabase → **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly `daily-recap`. Replace the sample code with everything in
   `supabase/functions/daily-recap/index.ts`. Click **Deploy**.
3. Open the function's **Details/Settings** and turn **Verify JWT** **OFF** (it uses its own secret instead). Save.
4. **Edge Functions → Secrets** → add:

| Name | Value |
|---|---|
| `CRON_SECRET` | make up a long random string (30+ characters) |
| `MS_TENANT_ID` | Directory (tenant) ID |
| `MS_MAILER_CLIENT_ID` | Help Desk Mailer client ID |
| `MS_MAILER_CLIENT_SECRET` | Help Desk Mailer secret Value |
| `RECAP_FROM` | `jmccord@1915south.com` |
| `RECAP_TO` | `jmccord@1915south.com` (comma-separate to add more) |
| `APP_URL` | `YOUR-SITE` (e.g. `https://1915south.github.io/helpdesk`) |

**Never put these secrets in the GitHub repo** — they belong only in Supabase.

## 10. Send yourself a test recap

In PowerShell (fill in your project ref and CRON_SECRET):

```powershell
Invoke-RestMethod -Method Post -Uri "https://YOUR-PROJECT-REF.supabase.co/functions/v1/daily-recap?force=1" -Headers @{ "x-cron-secret" = "YOUR-CRON-SECRET" }
```

You should see `sent: True` and get the email within a minute. If you see an error, it will say which step is wrong.

## 11. Schedule it for 5 AM Eastern

Copy `supabase/02_schedule_recap.sql` into the Supabase SQL Editor, replace `YOUR-PROJECT-REF` and
`YOUR-CRON-SECRET` **in the editor** (not in the GitHub file — the secret shouldn't be public), then **Run**.
It handles daylight saving automatically.

---

## 12. Roll out to employees (send them this)

> **New: Help Desk app**
> 1. On your iPad, open **Safari** and go to **YOUR-SITE**
> 2. Tap the **Share** button (square with arrow) → **Add to Home Screen** → **Add**.
> 3. Open **Help Desk** from your Home Screen and sign in with your 1915south.com Microsoft account.
> 4. Pick your home store. That's it — you'll stay signed in.

Sign in *after* adding to the Home Screen: the Home Screen app keeps its own sign-in, separate from Safari.

## Using it as the admin

- **Dashboard**: color-coded by priority (red High, yellow Medium, green Low). Tap the tiles to filter. Filter by location, category, status; search by name, customer, phone, or sale #.
- **Live alerts**: while the app is open you get a pop-up + chime for every new ticket and employee reply (High priority gets a stronger chime). Tap **Test alerts** once after opening the app so the browser allows sound. The green **Live** dot means you're connected.
- **On a ticket**: change status (Open → In Progress → Resolved) or priority, and reply. Employees see replies and status changes instantly.
- **Light / dark mode**: everyone can tap the sun/moon button in the top bar, or go to **Settings → Appearance** and pick System, Light or Dark. *System* follows the iPad's own setting. The choice is remembered on each device.
- **Raw data**: Supabase → **Table Editor → tickets** (includes a `priority_color` column).

## Good to know

- **Cost:** GitHub Pages (public repo) and the Supabase free tier cover this. Supabase pauses free projects after ~7 days with *no* activity; normal daily use prevents that. The Pro plan ($25/mo) adds daily backups and never pauses — worth it once you depend on this.
- **Secrets expire:** both Entra client secrets expire (max 24 months). When one does, sign-in or the recap email stops — create a new secret and paste it into the same place.
- **Adding a location:** edit the `LOCATIONS` list in `docs/app.js` and the two location lists in `supabase/01_schema.sql`, then re-run the changed part in Supabase (ask Claude to make the change).
- **Who sees what:** employees only see their own tickets. Only admins see everything and can change status/priority. This is enforced by the database, not just the screen — which is also why a public repo is safe.
