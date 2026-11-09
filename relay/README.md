# Results relay

This Cloudflare Worker does four jobs for the uploaders:

- `POST /results` accepts robot test results and files them as GitHub issues in
  the team's data repository. The GitHub token stays in the Worker secret store,
  so uploaders do not need GitHub accounts.
- `GET /map` gives the uploaders' Route Map tab its data. It needs the team code.
- `POST /plans` files a route someone drew on the map as a proposal. It needs the
  team code. A plan never changes a route, the map data, or robot code.
- `/partners` and `/partner/map` share the match autonomous prediction with
  alliance partners, each with their own password.

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

## Alliance partners

- `GET /partners`, with `X-Team-Code`: answers `{ok, teams}`, where each team is
  `{name, code, build, added}`. `code` is that team's password.
- `POST /partners`, with `X-Team-Code` and a JSON body `{name, code, build}`: adds
  the team, or updates it when the name is already on the list (case does not
  matter). `build` is a release tag like `build-70-abc1234` that has a stored
  prediction, or `latest`. Answers `201` when added, `200` when updated, with the
  whole list.
- `DELETE /partners?name=<name>`, with `X-Team-Code`: removes the team. Its
  password stops working within a minute. Answers `404` if no team has that name.
- `GET /partner/map`, with `X-Partner-Code`: answers
  `{ok, team, tag, build, generated, routes}` for the team whose password
  matches.
- `OPTIONS /partners` and `OPTIONS /partner/map`: CORS preflight.

The list is one key in the `MAP` namespace, `partners`:
`{"version":1,"teams":[{name, code, build, added}]}`. It holds up to 20 teams.
Names are 1 to 40 characters. Passwords are 4 to 64 plain characters, stored in
lower case and compared trimmed and in lower case. A password can't be the team
code or the ingest token, and two teams can't share one. Nothing new is needed in
`wrangler.toml` or the secrets.

`/partner/map` only ever sends the match autonomous routes, `awp-L` and `awp-R`,
rebuilt from the fields the map draws (time, x, y, heading, and the step
events). Skills, RECF, taught routes, any route id it doesn't know, the recorded
data, plans and the assumptions are left out on the relay, so they never reach
the partner's browser. The `commit` field is left out too; the tag carries the
short hash, which the public releases already show. If the stored prediction is
missing or not the expected shape, the answer has no routes rather than the
stored data. A partner
can't pick a build: they get the one set for their team. Every stored password is
checked, with no early exit and on SHA-256 hashes so each check takes the same
time. A wrong or missing password gets `401 {"ok":false,"error":"wrong password"}`
either way. Partner passwords are not accepted by any other route, and the team
code is not accepted by `/partner/map`.

Reading the list and `/partner/map` share the read limit (about 30 per minute
from one address). Adding and removing share the send limit (about 10 per
minute). Both are checked before any code. KV can take up to a minute to show a
change everywhere, so a removed partner may get in for up to a minute after.

The relay is deployed by hand. After changing `src/index.js`, run
`npx wrangler deploy` from `relay/`. The partner routes only work once it has
been redeployed with them.

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
