#!/bin/bash
# Publishes the version in package.json as a GitHub release: builds every app, tags vX.Y.Z and
# uploads the files under fixed names, so links like
#   https://github.com/<owner>/tuna/releases/latest/download/Tuna-android.apk
# always give the newest one. Pushing the tag also makes GitHub build the server image
# (ghcr.io/<owner>/tuna:<version> and :latest, see .github/workflows/docker.yml).
# Needs a Mac (for the Mac and iPhone apps), the GitHub CLI signed in (gh auth login), and everything committed.
#   SKIP_BUILD=1 scripts/release.sh   publishes the files already in release/
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
OWNER=$(gh repo view --json owner -q .owner.login)

[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first." >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "$TAG already exists: raise the version in package.json first." >&2
  exit 1
fi
grep -q "'$VERSION'" apps/android/app/build.gradle || { echo "Set the version to '$VERSION' in apps/android/app/build.gradle." >&2; exit 1; }
# The release page opens with this version's entry in CHANGELOG.md ("## X.Y.Z (date)" up to the next "## ").
WHATS_NEW=$(awk -v v="$VERSION" 'index($0, "## " v " ") == 1 || $0 == "## " v { on = 1; next } on && /^## / { exit } on { print }' CHANGELOG.md)
[ -n "$(echo "$WHATS_NEW" | tr -d '[:space:]')" ] || { echo "Write the entry for $VERSION in CHANGELOG.md first (\"## $VERSION ($(date +%F))\")." >&2; exit 1; }

if [ "${SKIP_BUILD:-}" != 1 ]; then
  npm run pack:server
  npm run build:mac
  npm run build:android
  npm run build:windows
  npm run build:samsung
  npm run build:ios
fi

STAGE=$(mktemp -d)
for kind in server.tar.gz mac.dmg mac.zip windows.exe android.apk samsung.wgt ios.ipa; do
  cp "release/Tuna-$VERSION-$kind" "$STAGE/Tuna-$kind"
done
{
  echo "## What's new"
  echo
  echo "$WHATS_NEW"
  echo
  echo "Every version: [CHANGELOG.md](https://github.com/$OWNER/tuna/blob/main/CHANGELOG.md)"
  echo
} > "$STAGE/notes.md"
cat >> "$STAGE/notes.md" <<NOTES
## Install

| For | Get |
|---|---|
| **Server** (any Docker host) | Portainer pulls \`ghcr.io/$OWNER/tuna:latest\` (or \`:$VERSION\`), see the README. Or upload **Tuna-server.tar.gz** in Portainer to build the image on the server itself. |
| **Mac** (Apple silicon, macOS 15 or later) | **Tuna-mac.dmg** |
| **Windows 10/11** (64-bit) | **Tuna-windows.exe** |
| **Android**: phones, tablets, Fire TV, Android TV | **Tuna-android.apk** (\`https://github.com/$OWNER/tuna/releases/latest/download/Tuna-android.apk\`) |
| **Samsung TV** (2022 or newer) | **Tuna-samsung.wgt**, installed with TizenBrew or Tizen Studio |
| **iPhone & iPad** | **Tuna-ios.ipa** for AltStore/SideStore, or install with Xcode |

The apps aren't signed by Apple or Microsoft yet: on a Mac, right-click → **Open** the first time; on Windows, **More info → Run anyway**.

NOTES

git tag -a "$TAG" -m "Tuna $VERSION"
git push origin "$TAG"
gh release create "$TAG" --title "Tuna $VERSION" --notes-file "$STAGE/notes.md" --generate-notes \
  "$STAGE/Tuna-server.tar.gz" "$STAGE/Tuna-mac.dmg" "$STAGE/Tuna-mac.zip" "$STAGE/Tuna-windows.exe" "$STAGE/Tuna-android.apk" \
  "$STAGE/Tuna-samsung.wgt" "$STAGE/Tuna-ios.ipa"
rm -rf "$STAGE"
find release -maxdepth 1 -name 'Tuna-*' ! -name "Tuna-$VERSION-*" -delete
echo "Published https://github.com/$OWNER/tuna/releases/tag/$TAG"
