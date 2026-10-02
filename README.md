# 1915 South Help Desk

Employee help-desk tickets for 1915 South's stores and DC. Employees sign in once with a 6-digit code
sent to their @1915south.com email, pin the app to their iPad, and submit tickets. Each ticket has:

- **Category:** Question, Problem or Request
- **Priority:** Low (green), Medium (yellow) or High (red)
- **Location:** 1201 Greensboro, 1202 Winston Salem, 1203 Burlington, 1204 Danville, 1205 Greensboro Outlet or DC
- **Sale details** (required when the ticket is about a sale): customer name, phone and sale number
- Optional photos and a reply thread

The admin dashboard is color-coded by priority, updates live with pop-up and sound alerts, and a recap
email goes out every day at 5 AM Eastern.

**Live site:** GitHub Pages serves the `docs/` folder. **Demo with fake data:** add `?demo` to the site address.

| Folder | Contents |
|---|---|
| `docs/` | The web app (plain HTML/JS, no build step) |
| `supabase/` | Database schema, daily-recap Edge Function, and its schedule |

See **[SETUP.md](SETUP.md)** for the full setup.
