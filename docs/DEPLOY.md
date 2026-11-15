# Going live: hosting, domain and email

This repository is ready to publish as it is. Pick **one** hosting option
(A or B), then do the email section.

Do these first, whichever host you choose:

1. Register `amanogeospatial.com` at a registrar (Cloudflare, Namecheap, GoDaddy).
2. Push this repository to GitHub.

---

## Option A — GitHub Pages (simplest, everything stays in GitHub)

Free on a **public** repository. (Pages on a private repository needs a paid
GitHub plan.)

### 1. Turn Pages on

1. Open the repository on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose branch **main**, folder **/ (root)** → **Save**.
4. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

### 2. Connect the domain

Add the domain in GitHub **before** touching DNS:

1. **Settings** → **Pages** → **Custom domain** → type `amanogeospatial.com` → **Save**.
   GitHub adds a file called `CNAME` to the repository. Leave it there.
2. At your registrar's DNS page, add these records:

| Type | Name / Host | Value |
| --- | --- | --- |
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| AAAA (optional) | `@` | `2606:50c0:8000::153` |
| AAAA (optional) | `@` | `2606:50c0:8001::153` |
| AAAA (optional) | `@` | `2606:50c0:8002::153` |
| AAAA (optional) | `@` | `2606:50c0:8003::153` |
| CNAME | `www` | `<your-username>.github.io` |

   If the DNS is at Cloudflare, set these records to **DNS only** (grey cloud)
   so GitHub can issue the certificate.
3. Back in **Settings** → **Pages**, wait for the DNS check to pass, then tick
   **Enforce HTTPS**. The certificate can take up to an hour to appear.

These addresses come from GitHub's documentation ("Managing a custom domain for
your GitHub Pages site"). Check that page if a record is refused.

---

## Option B — Cloudflare Pages (best if the domain is registered at Cloudflare)

Works with a private repository, and the DNS is filled in for you when the
domain lives in the same Cloudflare account.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**.
2. Authorise Cloudflare for GitHub and select this repository.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
4. **Save and Deploy**. The site appears at `<project>.pages.dev`.
5. Open the project → **Custom domains** → **Set up a custom domain** → enter
   `amanogeospatial.com`. Repeat for `www.amanogeospatial.com`.
6. HTTPS switches on by itself.

Every push to `main` republishes the site automatically.

---

## Email on the domain

The site's buttons currently open an email to `chisala.jh@gmail.com`, a
temporary address, so the site can go live before the domain mailbox exists.
When you are ready for an address on the domain (for example
`hello@amanogeospatial.com`), set it up as below and then swap the address in
`index.html`.

**Zoho Mail (free tier).** Note two limits before choosing it: the free plan is
only offered in some Zoho data-centre regions (you find out at sign-up), and it
is webmail and Zoho's mobile app only — no Outlook/IMAP. If the free plan is not
offered to you, the cheapest paid plan or Google Workspace are the alternatives.

Zoho's setup wizard gives you the exact values for your account; they differ by
region, so copy them from the wizard rather than from here. You will add:

| Type | Name / Host | What it is for |
| --- | --- | --- |
| TXT | `@` | Proves you own the domain (`zoho-verification=…`) |
| MX ×3 | `@` | Delivers incoming mail to Zoho (priorities 10, 20, 50) |
| TXT | `@` | SPF — says Zoho may send mail for the domain |
| TXT | `<selector>._domainkey` | DKIM — signs outgoing mail (Zoho gives you the selector name) |
| TXT | `_dmarc` | DMARC policy, e.g. `v=DMARC1; p=none; rua=mailto:hello@amanogeospatial.com` |

Mail records and website records sit side by side at the registrar; adding one
set does not disturb the other. Keep only **one** SPF record on the domain.

Then send a test email to the new address from another account and confirm it
arrives.

---

## After it is live

- Open `https://amanogeospatial.com` on your phone and your laptop.
- Check the padlock, the favicon in the tab, and that **Request a demo** opens
  an email to the right address.
- Paste the link into a WhatsApp chat with yourself to check the preview image.
  LinkedIn caches previews; its "Post Inspector" tool refreshes them.
