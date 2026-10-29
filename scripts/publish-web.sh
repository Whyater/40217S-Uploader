#!/usr/bin/env bash
# Publish the web uploader to GitHub Pages (the gh-pages branch), built on
# this machine so it needs no GitHub Actions. Run it from the repo root
# after a new release is published, or after changing web/.
#
#   scripts/publish-web.sh
#
# It runs the web tests, copies web/ into the gh-pages branch, downloads the
# latest release's files into build/, checks every SHA-256 hash listed in
# release.json, stamps the service worker so installed copies update, and
# pushes. It refuses to publish if anything fails.
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
jq -r '.sha256 // {} | to_entries[] | "\(.value | ascii_downcase)  \(.key)"' "$site/build/release.json" > "$site/build.sha256"
(cd "$site/build" && shasum -a 256 -c ../build.sha256 > /dev/null) || {
  echo "A file in $tag failed its SHA-256 check." >&2; exit 1; }
rm "$site/build.sha256"

stamp="$(git rev-parse --short HEAD)-$tag"
sed -i '' "s/^const VERSION = 'dev';/const VERSION = '$stamp';/" "$site/sw.js"
grep -q "const VERSION = '$stamp';" "$site/sw.js" || { echo "Couldn't stamp sw.js." >&2; exit 1; }

git -C "$site" add -A
if git -C "$site" diff --cached --quiet; then
  echo "Nothing changed. The site already has $tag."
  exit 0
fi
git -C "$site" commit -q -m "Publish web uploader $(git rev-parse --short HEAD) with $tag"
git -C "$site" push -q origin gh-pages
echo "Published $tag. Live in a minute or two at https://whyater.github.io/40217S-Uploader/"
