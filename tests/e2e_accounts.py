"""Accounts and history in the browser, with an in-memory stand-in for the account service.
Checks the sign-in gate, sign-up, wrong password, history recording, search, per-user separation
and sign-out. It does not test a real Supabase project or its database rules."""
import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8795; OUT = "/tmp/amano-acct"; os.makedirs(OUT, exist_ok=True)
FAKE = """
(() => {
  const users = new Map(), rows = []; let session = null, cb = null, n = 0;
  const emit = (ev) => cb && cb(ev, session);
  const q = (table) => { const st = { filters: [], op: 'select', payload: null };
    const run = async () => {
      if (!session) return { data: null, error: { message: 'not signed in' } };
      const mine = rows.filter((r) => r.user_id === session.user.id && st.filters.every(([k, v]) => r[k] === v));
      if (st.op === 'insert') { const r = { id: 'r' + ++n, user_id: session.user.id, created_at: new Date().toISOString(), ...st.payload }; rows.push(r); return { data: st.single ? r : [r], error: null }; }
      if (st.op === 'update') { mine.forEach((r) => Object.assign(r, st.payload)); return { data: null, error: null }; }
      if (st.op === 'delete') { mine.forEach((r) => rows.splice(rows.indexOf(r), 1)); return { data: null, error: null }; }
      return { data: mine.slice().reverse(), error: null }; };
    const api = { insert: (p) => (st.op = 'insert', st.payload = p, api), update: (p) => (st.op = 'update', st.payload = p, api), delete: () => (st.op = 'delete', api),
      select: () => api, single: () => (st.single = true, api), eq: (k, v) => (st.filters.push([k, v]), api), order: () => api, limit: () => api, then: (a, b) => run().then(a, b) };
    return api; };
  window.__fakeRows = rows;
  window.AMANO_SUPABASE_CLIENT = { from: q, auth: {
    onAuthStateChange: (f) => { cb = f; return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => ({ data: { session }, error: null }),
    signUp: async ({ email, password, options }) => { if (users.has(email)) return { data: {}, error: { message: 'User already registered' } };
      const user = { id: 'u' + (users.size + 1), email, user_metadata: options.data }; users.set(email, { password, user }); session = { user }; emit('SIGNED_IN'); return { data: { session, user }, error: null }; },
    signInWithPassword: async ({ email, password }) => { const u = users.get(email); if (!u || u.password !== password) return { data: {}, error: { message: 'Invalid login credentials' } };
      session = { user: u.user }; emit('SIGNED_IN'); return { data: { session }, error: null }; },
    signOut: async () => { session = null; emit('SIGNED_OUT'); return { error: null }; },
    resetPasswordForEmail: async () => ({ data: {}, error: null }), updateUser: async () => ({ data: {}, error: null }) } };
})();
"""
async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    ok = True
    def chk(name, cond):
        nonlocal ok; print(("ok  " if cond else "BAD ") + name); ok &= bool(cond)
    try:
        async with async_playwright() as p:
            try: b = await p.chromium.launch()
            except Exception: b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
            pg = await b.new_page(viewport={"width": 1440, "height": 900})
            errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.add_init_script(FAKE)
            await pg.goto(f"http://localhost:{PORT}/app/"); await pg.wait_for_function("window.amano")
            await pg.wait_for_selector("#auth:not([hidden])")
            chk("gate shown before sign-in, app controls covered", await pg.is_visible("#auth-form") and not await pg.is_visible("#acct-btn"))
            await pg.screenshot(path=f"{OUT}/1-signin.png")
            await pg.fill("#auth-email", "ken@example.com"); await pg.fill("#auth-pass", "wrong-pass"); await pg.click("#auth-submit")
            await pg.wait_for_function("document.getElementById('auth-msg').textContent.length > 0")
            chk("unknown account rejected: " + await pg.inner_text("#auth-msg"), await pg.is_visible("#auth-form"))
            await pg.click("#auth-switch")
            await pg.fill("#auth-name", "Kennedy Chisala"); await pg.fill("#auth-pass", "short"); await pg.click("#auth-submit")
            chk("short password refused: " + await pg.inner_text("#auth-msg"), await pg.is_visible("#auth-form"))
            await pg.screenshot(path=f"{OUT}/2-signup.png")
            await pg.fill("#auth-pass", "correct-horse-9"); await pg.click("#auth-submit")
            await pg.wait_for_selector("#auth", state="hidden")
            chk("signed in after sign-up; initials " + await pg.inner_text("#acct-initials"), await pg.is_visible("#acct-btn") and await pg.is_visible("#nav-history"))
            # do some work
            await pg.click("#btn-sample"); await pg.wait_for_function("amano.state.src && document.getElementById('busy').hidden")
            await pg.click("#assist summary"); await pg.click("#btn-detect")
            await pg.wait_for_function("!document.getElementById('assist-form').hidden && document.getElementById('busy').hidden")
            for i, v in (("#as-e0", "360000"), ("#as-de", "1000"), ("#as-n0", "8646000"), ("#as-dn", "1000")): await pg.fill(i, v)
            await pg.click("#btn-assist")
            await pg.fill("#crs", "20935"); await pg.dispatch_event("#crs", "change")
            await pg.wait_for_function("window.__fakeRows.length === 1", timeout=8000)
            await pg.click("#tool-pick")
            box = await pg.locator("#view").bounding_box()
            await pg.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
            await pg.click("#btn-extract"); await pg.wait_for_function("amano.state.features.length > 0 && document.getElementById('busy').hidden")
            await pg.click("#nav-history"); await pg.wait_for_selector("#hist-body tr")
            row = await pg.inner_text("#hist-body tr")
            chk("history row: " + " | ".join(row.split()), "Digitized" in row and "sample-map.jpg" in row and "20935" in row)
            chk("one record, not duplicates", await pg.evaluate("window.__fakeRows.length") == 1 and "all 1 record" in await pg.inner_text("#hist-count"))
            await pg.click("#acct-btn"); await pg.wait_for_selector("#acct-menu:not([hidden])")
            await pg.screenshot(path=f"{OUT}/3-history.png")
            chk("menu shows name, email and usage: " + (await pg.inner_text("#acct-usage")), "Kennedy Chisala" in await pg.inner_text("#acct-name") and "1 map" in await pg.inner_text("#acct-usage"))
            await pg.keyboard.press("Escape"); await pg.click("#hist-search"); await pg.fill("#hist-search", "zzz")
            chk("search filters", await pg.locator("#hist-body tr").count() == 0)
            await pg.fill("#hist-search", "")
            await pg.click("#nav-work"); chk("back to workspace", await pg.is_visible("#view"))
            await pg.click("#acct-btn"); await pg.click("#acct-signout"); await pg.wait_for_selector("#auth:not([hidden])")
            chk("signed out: gate is back", not await pg.is_visible("#acct-btn"))
            # a second person sees nothing of the first
            await pg.click("#auth-switch"); await pg.fill("#auth-name", "Second User"); await pg.fill("#auth-email", "other@example.com"); await pg.fill("#auth-pass", "another-pass-1"); await pg.click("#auth-submit")
            await pg.wait_for_selector("#auth", state="hidden"); await pg.click("#nav-history"); await pg.wait_for_timeout(500)
            chk("second user has an empty history", await pg.locator("#hist-body tr").count() == 0)
            await pg.click("#acct-btn"); await pg.click("#acct-signout"); await pg.wait_for_selector("#auth:not([hidden])")
            await pg.fill("#auth-email", "ken@example.com"); await pg.fill("#auth-pass", "correct-horse-9"); await pg.click("#auth-submit")
            await pg.wait_for_selector("#auth", state="hidden"); await pg.click("#nav-history"); await pg.wait_for_selector("#hist-body tr")
            chk("first user's history is still there after signing back in", await pg.locator("#hist-body tr").count() == 1)
            chk("no page errors " + str(errs), not errs)
            await b.close()
    finally:
        srv.terminate()
    print("ACCOUNTS", "PASSED" if ok else "FAILED"); sys.exit(0 if ok else 1)
asyncio.run(main())
