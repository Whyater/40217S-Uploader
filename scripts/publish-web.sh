#!/usr/bin/env bash
# Publish the web uploader to GitHub Pages (the gh-pages branch), built on
# this machine or by the "Publish web uploader" workflow. Run it from the repo root
# after a new release is published, or after changing web/.
#
#   scripts/publish-web.sh
#
# It runs the web tests, copies web/ into the gh-pages branch, downloads the
# latest release's files into build/ and the 3 highest-numbered other full builds
# (from full-builds.json) into build/<tag>/, checks every SHA-256 hash listed in
# each release.json, writes build/builds.json, stamps the service worker so
# installed copies update, and pushes. It refuses to publish if anything fails.
# Browsers can't read GitHub's release downloads (no CORS headers), so the full
# builds the app offers have to come from this site.
set -euo pipefail

repo="Whyater/40217S-Uploader"
root="$(git rev-parse --show-toplevel)"
cd "$root"

echo "Running the web tests"
node --test 'web/test/**/*.test.*' > /tmp/publish-web-tests.log 2>&1 || {
  tail -20 /tmp/publish-web-tests.log; echo "Tests failed, not publishing." >&2; exit 1; }

site="$(mktemp -d)"
trap 'git worktree remove --force "$site" 2>/dev/null || true; rm -rf "$site"' EXIT

git fetch -q origin
if git ls-remote --exit-code --heads origin gh-pages > /dev/null; then
  git worktree add -q -B gh-pages "$site" origin/gh-pages
else
  git worktree add -q --detach "$site"
  git -C "$site" checkout -q --orphan gh-pages
fi
git -C "$site" rm -rqf --ignore-unmatch . > /dev/null

cp -R web/. "$site/"
rm -rf "$site/test" "$site/package.json"
touch "$site/.nojekyll"

echo "Downloading the latest release"
mkdir -p "$site/build"
gh release download -R "$repo" --pattern '*' --dir "$site/build" --clobber
tag="$(jq -r .tag "$site/build/release.json")"
for f in hot.package.bin cold.package.bin project.pros; do
  [ -f "$site/build/$f" ] || { echo "Release $tag is missing $f." >&2; exit 1; }
done
# Slot 4 ships as cascade-hot.package.bin (older releases: autopath-hot.package.bin); both are optional like the other test modes.
for f in auton-test-hot.package.bin drive-test-hot.package.bin cascade-hot.package.bin autopath-hot.package.bin; do
  [ -f "$site/build/$f" ] && echo "  $tag includes $f"
done
# Checks every file a build's release.json lists against its SHA-256 hash.
check_hashes() { # dir tag
  jq -r '.sha256 // {} | to_entries[] | "\(.value | ascii_downcase)  \(.key)"' "$1/release.json" > "$site/build.sha256"
  (cd "$1" && shasum -a 256 -c "$site/build.sha256" > /dev/null) || {
    echo "A file in $2 failed its SHA-256 check." >&2; exit 1; }
  rm "$site/build.sha256"
}
check_hashes "$site/build" "$tag"

# The full builds the app's picker offers besides the newest, same rules as the app:
# version 1, real build tags, highest number first.
jq -e '.version == 1 and (.builds | type == "array")' full-builds.json > /dev/null || {
  echo "full-builds.json is not a version 1 list." >&2; exit 1; }
fulls="$(jq -r --arg newest "$tag" '[.builds[] | objects | .tag | select(type == "string" and test("^build-[0-9]{1,9}-[0-9a-f]{7}$") and . != $newest)]
  | unique | sort_by(capture("^build-(?<n>[0-9]+)").n | tonumber) | reverse | .[0:3][]' full-builds.json)"
bundled=()
for t in $fulls; do
  echo "Bundling full build $t"
  mkdir -p "$site/build/$t"
  gh release download "$t" -R "$repo" --pattern '*' --dir "$site/build/$t" --clobber
  [ "$(jq -r .tag "$site/build/$t/release.json")" = "$t" ] || { echo "$t has a release.json for another build." >&2; exit 1; }
  for f in hot.package.bin cold.package.bin project.pros; do
    [ -f "$site/build/$t/$f" ] || { echo "Release $t is missing $f." >&2; exit 1; }
  done
  check_hashes "$site/build/$t" "$t"
  bundled+=("$t")
done
jq -n --arg newest "$tag" '{version: 1, newest: $newest, builds: $ARGS.positional}' \
  --args ${bundled[@]+"${bundled[@]}"} > "$site/build/builds.json"
echo "Site build files: $(du -sh "$site/build" | cut -f1)"

stamp="$(git rev-parse --short HEAD)-$tag"
sed -i.bak "s/^const VERSION = 'dev';/const VERSION = '$stamp';/" "$site/sw.js" && rm -f "$site/sw.js.bak"
grep -q "const VERSION = '$stamp';" "$site/sw.js" || { echo "Couldn't stamp sw.js." >&2; exit 1; }

git -C "$site" add -A
if git -C "$site" diff --cached --quiet; then
  echo "Nothing changed. The site already has $tag."
  exit 0
fi
git -C "$site" commit -q -m "Publish web uploader $(git rev-parse --short HEAD) with $tag"
git -C "$site" push -q origin gh-pages
echo "Published $tag. Live in a minute or two at https://whyater.github.io/40217S-Uploader/"
