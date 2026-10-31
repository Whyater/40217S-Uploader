# Results relay

This Cloudflare Worker does three jobs for the uploaders:

- `POST /results` accepts robot test results and files them as GitHub issues in
  the team's data repository. The GitHub token stays in the Worker secret store,
  so uploaders do not need GitHub accounts.
- `GET /map` gives the uploaders' Route Map tab its data. It needs the team code.
- `POST /plans` files a route someone drew on the map as a proposal. It needs the
  team code. A plan never changes a route, the map data, or robot code.

## Routes

- `POST /results`, with an `X-Scourge-Client` header: files the results as one or
  more issues. With the right `X-Team-Code` header the relay also adds the `team`
  label and answers `on_map: true`. A wrong or missing code still files, with no
  label and `on_map: false`. Senders can't set labels themselves.
- `GET /map?build=<tag>`, with an `X-Team-Code` header: returns the stored data
  for that build, and the recorded data.
- `GET /map`, with an `X-Team-Code` header: same, for the newest published build.
- `PUT /map/recorded`, with `Authorization: Bearer <INGEST_TOKEN>`: stores the
  recorded data. The body must be a JSON object, at most 10 MB.
- `OPTIONS /map`: CORS preflight.
- `POST /plans`, with `X-Team-Code` and `X-Scourge-Client` headers: files one issue
  titled `Proposed auto plan: <name>`, labelled `proposed-auto-plan` when the label
  exists. Answers `201 {ok, issue}`.
- `OPTIONS /plans`: CORS preflight.

`GET /map` answers `{ok, sim, recorded, recorded_updated, sim_is_latest}`. `sim`
and `recorded` are null when nothing is stored. A wrong or missing team code gets
a 401. If the `TEAM_CODE` secret is not set the route answers 500, and never opens
up. The browser may only call `/map` from
`https://whyater.github.io`, the web uploader's address.

`POST /plans` takes a plan of at most 200 KB and rebuilds it from the fields it
knows, rounded to 2 places. A wrong or missing team code gets a 401, a missing
client header a 403, a bad shape a 400, too large a 413, and a GitHub failure a
502.
The name and note only appear in the title and inside a JSON code fence, so an `@`
in them notifies nobody. The browser may only call `/plans` from
`https://whyater.github.io`.

Per-build data is written to the `MAP` namespace with
`npx wrangler kv key put "sim/<tag>" --binding MAP --remote --path <file>`, not
over HTTP.

## One-time setup

1. Create a free Cloudflare account and install Wrangler.
2. Run `npx wrangler login`.
3. Create a fine-grained GitHub token limited to
   `Whyater/40217S-Robot-Data` with Issues read and write permission.
4. Add it to the Worker: `npx wrangler secret put GITHUB_TOKEN`.
5. Run `npx wrangler kv namespace create MAP` and put the printed id in
   `wrangler.toml`. The id is not a secret.
6. Add the other two secrets: `npx wrangler secret put TEAM_CODE` and
   `npx wrangler secret put INGEST_TOKEN`.
7. Create the label: `gh label create team -R Whyater/40217S-Robot-Data`.
8. Create the plans label: `gh label create proposed-auto-plan -R Whyater/40217S-Robot-Data`.
9. Deploy: `npx wrangler deploy`.
10. Put the printed Worker URL plus `/results` in `results_url` in
   `uploader.json` and `mac-uploader.json`.

## Known limits

Anyone who can read the public uploader can post issues to the data repository.
The relay does not let them read anything from that repository, and without the
team code their issues don't get the label, so they never reach the map.
A rate limit keeps that to about 10 sends per minute from one address.

A plan has to fit in one 60000-character issue. A drawing near the 3000-point limit
may not, and gets a 413 asking for fewer points.

Map reads are limited to about 30 per minute from one address, to slow guessing
the team code. Cloudflare counts these per location, so both limits are approximate.
