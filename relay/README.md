# Results relay

This Cloudflare Worker accepts robot test results from the uploader and files
them as GitHub issues in the team's data repository. The GitHub token stays in
the Worker secret store, so uploaders do not need GitHub accounts.

## One-time setup

1. Create a free Cloudflare account and install Wrangler.
2. Run `npx wrangler login`.
3. Create a fine-grained GitHub token limited to
   `Whyater/40217S-Robot-Data` with Issues read and write permission.
4. Add it to the Worker: `npx wrangler secret put GITHUB_TOKEN`.
5. Deploy: `npx wrangler deploy`.
6. Put the printed Worker URL plus `/results` in `results_url` in
   `uploader.json` and `mac-uploader.json`.

## Known limit

Anyone who can read the public uploader can post issues to the data repository.
The relay does not let them read anything from that repository.
A rate limit keeps that to about 10 sends per minute from one address.
