// Amano Georeferencer — accounts and activity history (Supabase).
// Switched on by filling supabaseUrl and supabaseAnonKey in app/config.js. The anon key is a public
// value by design; what each person can read or change is enforced by the database rules in
// /backend/schema.sql (everyone sees only their own rows).

const TABLE = 'map_history';
let client = null, user = null;

export function configured() {
  const c = globalThis.AMANO_CONFIG || {};
  return !!(globalThis.AMANO_SUPABASE_CLIENT || (c.supabaseUrl && c.supabaseAnonKey));
}
export const currentUser = () => user;
export const displayName = () => user?.user_metadata?.full_name || user?.email || '';

function friendly(error) {
  const m = String(error?.message || error || '');
  if (/invalid login credentials/i.test(m)) return 'That email and password do not match an account.';
  if (/already registered|already been registered/i.test(m)) return 'There is already an account with that email. Sign in instead.';
  if (/email not confirmed/i.test(m)) return 'Confirm your email first: open the link we sent you, then sign in.';
  if (/password should be at least|weak password/i.test(m)) return 'Choose a longer password (at least 8 characters).';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a few minutes and try again.';
  if (/failed to fetch|network/i.test(m)) return 'Could not reach the account service. Check your internet connection.';
  if (/invalid.*email|unable to validate email/i.test(m)) return 'That does not look like a valid email address.';
  return m || 'Something went wrong. Try again.';
}
const check = (res) => { if (res.error) throw new Error(friendly(res.error)); return res.data; };

/**
 * Start the account system. onChange(user, event) is called on sign-in, sign-out and password recovery.
 * Returns the signed-in user, or null.
 */
export async function init(onChange) {
  if (!configured()) return null;
  const c = globalThis.AMANO_CONFIG || {};
  client = globalThis.AMANO_SUPABASE_CLIENT || globalThis.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey);
  client.auth.onAuthStateChange((event, session) => {
    const before = user?.id;
    user = session?.user || null;
    if (event === 'PASSWORD_RECOVERY' || before !== user?.id) onChange(user, event);
  });
  try { const { data } = await client.auth.getSession(); user = data?.session?.user || null; } catch { user = null; }
  return user;
}

export async function signUp(name, email, password) {
  const data = check(await client.auth.signUp({ email, password, options: { data: { full_name: name }, emailRedirectTo: location.origin + location.pathname } }));
  return { needsConfirmation: !data.session };
}
export async function signIn(email, password) { check(await client.auth.signInWithPassword({ email, password })); }
export async function signOut() { check(await client.auth.signOut()); }
export async function sendPasswordReset(email) { check(await client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })); }
export async function setNewPassword(password) { check(await client.auth.updateUser({ password })); }

/** Create (no id) or update a history record. Returns its id. */
export async function saveRecord(record, id = null) {
  if (!user) return null;
  if (id) { check(await client.from(TABLE).update(record).eq('id', id)); return id; }
  const row = check(await client.from(TABLE).insert(record).select('id').single());
  return row.id;
}
export async function listRecords() {
  if (!user) return [];
  return check(await client.from(TABLE).select('id,created_at,updated_at,file_name,title,status,crs,points,rms_px,thumbnail,details').order('created_at', { ascending: false }).limit(500)) || [];
}
export async function deleteRecord(id) { check(await client.from(TABLE).delete().eq('id', id)); }
