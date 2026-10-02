// In-memory demo data so you can click around without Supabase.
// Open the app with ?demo (admin view), ?demo&as=employee, or ?demo&as=new
// (signed out — shows the email-code sign-in; any 6-digit code works).
export function createDemoApi() {
  const as = new URLSearchParams(location.search).get("as");
  const asEmployee = as === "employee" || as === "new";
  const admin = { id: "u-admin", email: "jmccord@1915south.com", full_name: "J. McCord", home_location: "DC", is_admin: true };
  const emp = { id: "u-emp", email: "sam.taylor@1915south.com", full_name: "Sam Taylor", home_location: "1201 Greensboro", is_admin: false };
  const me = asEmployee ? emp : admin;
  let authCb = null;
  if (as === "new") Object.assign(me, { home_location: null });
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();

  let nextId = 1009, nextComment = 10;
  const tickets = [
    t(1001, "1203 Burlington", "Problem", "High", "In Progress", "Card reader on Register 1 declining every card", "Started at open. Tried restarting the reader twice.", 26, "Dana Price"),
    t(1002, "1201 Greensboro", "Request", "Low", "Open", "Need 2 more receipt paper cases", "Running low, about a week left.", 50, "Sam Taylor"),
    t(1003, "1205 Greensboro Outlet", "Question", "Medium", "Open", "How do I process an exchange on a clearance item?", "Customer wants a different size of a final-sale sofa.", 5, "Chris Lee",
      { is_sale: true, customer_name: "Pat Morgan", customer_phone: "3365550142", sale_number: "S-448120" }),
    t(1004, "DC", "Problem", "Medium", "Open", "Label printer in receiving is jamming", "Jams every 3–4 labels.", 3, "Alex Brooks"),
    t(1005, "1202 Winston Salem", "Problem", "High", "Open", "Delivery scheduled to wrong address", "Customer called — truck is heading to their old address.", 1, "Jordan Diaz",
      { is_sale: true, customer_name: "Riley Owens", customer_phone: "3365550199", sale_number: "S-448377" }),
    t(1006, "1204 Danville", "Request", "Low", "Resolved", "New employee login for Morgan", "Starts Monday.", 80, "Taylor Kim"),
    t(1007, "1201 Greensboro", "Question", "Low", "Resolved", "Where do I find last month's sales report?", "", 120, "Sam Taylor"),
    t(1008, "1201 Greensboro", "Problem", "Medium", "Open", "Back office PC very slow", "Takes 5 minutes to open the POS.", 8, "Sam Taylor"),
  ];
  tickets.forEach((x) => { if (x.requester_name === "Sam Taylor") x.created_by = emp.id; });
  const comments = [
    { id: 1, ticket_id: 1001, author_id: admin.id, author_name: admin.full_name, author_is_admin: true, body: "On it — can you try the backup reader in the drawer while I call the processor?", created_at: ago(25) },
    { id: 2, ticket_id: 1001, author_id: "x", author_name: "Dana Price", author_is_admin: false, body: "Backup works. Thanks!", created_at: ago(24.5) },
    { id: 3, ticket_id: 1008, author_id: admin.id, author_name: admin.full_name, author_is_admin: true, body: "I'll remote in at 2pm. Leave it on please.", created_at: ago(6) },
  ];
  const subs = new Set();
  const emit = (kind, row) => subs.forEach((s) => (!s.ticketId || s.ticketId === (row.ticket_id ?? row.id)) && s.handlers[kind]?.(structuredClone(row)));

  function t(id, location, category, priority, status, title, description, hoursAgo, requester, sale = {}) {
    return {
      id, location, category, priority, status, title, description: description || title,
      created_at: ago(hoursAgo), updated_at: ago(hoursAgo), resolved_at: status === "Resolved" ? ago(hoursAgo - 2) : null,
      created_by: "u-other", requester_name: requester, requester_email: "",
      is_sale: false, customer_name: null, customer_phone: null, sale_number: null, ...sale,
    };
  }

  // Admin demo: a new ticket "arrives" 12 seconds after load to show live alerts.
  if (!asEmployee) setTimeout(() => {
    const n = t(nextId++, "1203 Burlington", "Problem", "High", "Open", "Customer waiting — can't look up order", "POS search returns nothing for any phone number.", 0, "Dana Price",
      { is_sale: true, customer_name: "Lee Carter", customer_phone: "3365550111", sale_number: "S-448402" });
    tickets.push(n); emit("ticketInsert", n);
  }, 12000);

  const visible = () => tickets.filter((x) => me.is_admin || x.created_by === me.id);
  const wait = (v) => new Promise((r) => setTimeout(() => r(structuredClone(v)), 150));

  return {
    onAuthChange: (cb) => { authCb = cb; setTimeout(() => cb(as === "new" ? null : { user: { id: me.id, email: me.email } }), 0); },
    sendCode: (email) => { me.email = email; me.full_name = email.split("@")[0].split(/[._-]/).map((s) => s[0].toUpperCase() + s.slice(1)).join(" "); return wait(null); },
    verifyCode: async (_email, code) => {
      await wait(null);
      if (!/^\d{6,10}$/.test(code)) throw new Error("Token has expired or is invalid");
      setTimeout(() => authCb({ user: { id: me.id, email: me.email } }), 0);
    },
    signOut: async () => { location.href = location.pathname + "?demo" + (asEmployee ? "" : "&as=employee"); },
    getProfile: () => wait(me),
    updateProfile: (_uid, patch) => { Object.assign(me, patch); return wait(me); },
    listTickets: ({ mineOnly, uid, statuses }) =>
      wait(visible().filter((x) => (!mineOnly || x.created_by === uid) && (!statuses || statuses.includes(x.status)))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))),
    getTicket: (id) => wait(visible().find((x) => x.id === id) || null),
    createTicket: (input) => {
      const n = { ...t(nextId++, input.location, input.category, input.priority, "Open", input.title, input.description, 0, me.full_name), ...input, status: "Open", created_by: me.id };
      if (!n.is_sale) Object.assign(n, { customer_name: null, customer_phone: null, sale_number: null });
      tickets.push(n); emit("ticketInsert", n); return wait(n);
    },
    updateTicket: (id, patch) => {
      const x = tickets.find((y) => y.id === id); Object.assign(x, patch, { updated_at: new Date().toISOString() });
      x.resolved_at = x.status === "Resolved" ? x.resolved_at || new Date().toISOString() : null;
      emit("ticketUpdate", x); return wait(x);
    },
    listComments: (id) => wait(comments.filter((c) => c.ticket_id === id)),
    addComment: (ticket_id, body) => {
      const c = { id: nextComment++, ticket_id, author_id: me.id, author_name: me.full_name, author_is_admin: me.is_admin, body, created_at: new Date().toISOString() };
      comments.push(c); emit("commentInsert", c); return wait(c);
    },
    listPhotos: () => wait([]),
    addPhoto: async () => {},
    subscribe: (_name, handlers, ticketId) => {
      const s = { handlers, ticketId }; subs.add(s);
      setTimeout(() => handlers.status?.("SUBSCRIBED"), 300);
      return () => subs.delete(s);
    },
  };
}
