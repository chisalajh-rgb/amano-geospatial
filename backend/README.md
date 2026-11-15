# Accounts and history (Supabase)

The app's sign-up, sign-in and History screens use a Supabase project for logins and for the
history table. Until the two values below are filled in, the app runs without accounts.

## Set up (about 15 minutes; the free plan is enough to start)

1. Create an account at supabase.com and a **New project**. Choose a region near your users
   and keep the database password somewhere safe (the app never needs it).
2. **SQL Editor** → **New query** → paste the contents of `schema.sql` → **Run**.
3. **Authentication** → **URL Configuration**: set **Site URL** to the app's address
   (`https://chisalajh-rgb.github.io/amano-geospatial/app/`, later `https://amanogeospatial.com/app/`)
   and add the same address under **Redirect URLs**.
4. **Project Settings** → **API**: copy the **Project URL** and the **anon / publishable key**
   into `app/config.js` as `supabaseUrl` and `supabaseAnonKey`. Commit and push.

Never put the `service_role` key or the database password in this repository: those bypass the
per-user rules. The anon key is meant to be public.

## Things to know

- New users must confirm their email by default. Supabase's built-in mailer only sends a few
  emails per hour; for real traffic connect your own mail service under Authentication → SMTP.
- History stores a summary and a small preview of each map, not the map itself or the exports.
- Passwords are handled by Supabase; the app and this repository never store them.
