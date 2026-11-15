# Amano AI server (optional)

Without this, each person using the app's AI steps must paste their own Anthropic API key
into the app's Settings. With it, your site holds one key on a small server and visitors need none.
You pay Anthropic for every map processed, so protect it with an access code.

## Set up (about 15 minutes, needs a Cloudflare account and an Anthropic API key)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Worker**. Name it `amano-ai`.
2. Replace the starter code with the contents of `worker.js` and **Deploy**.
3. Worker → **Settings** → **Variables and Secrets**. Add:
   - `ANTHROPIC_API_KEY` (Secret): your key from the Anthropic Console
   - `ALLOWED_ORIGINS` (Text): `https://amanogeospatial.com,https://chisalajh-rgb.github.io`
   - `ACCESS_CODE` (Secret, recommended): a code you give to trusted users
4. Copy the Worker's address (`https://amano-ai.<you>.workers.dev`) into `app/config.js` as `proxyUrl`,
   commit and push.

Set a monthly spend limit in the Anthropic Console as well. The key never goes in this repository.
