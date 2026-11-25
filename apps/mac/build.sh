#!/bin/bash
# Builds Tuna for Mac (in ~/Library/Caches/tuna-build/mac), and with --dmg the disk image in release/.
# Needs Xcode's command-line tools and Go (brew install go) for the tunnel. Nothing else: the music
# plays with macOS's own AVFoundation, so the app runs on any Mac with macOS 15 or later.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(node -p "require('../../package.json').version")
# Built outside the project, in a folder Spotlight and iCloud leave alone: otherwise every
# build shows up as another "Tuna" next to the installed one when you search for it.
BUILD="${XDG_CACHE_HOME:-$HOME/Library/Caches}/tuna-build/mac"
APP=$BUILD/Tuna.app

rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$BUILD/iconset.iconset"

swiftc -O -swift-version 5 -target arm64-apple-macos15.0 \
  -framework AppKit -framework WebKit -framework AVFoundation -framework MediaPlayer -framework Network \
  Tuna/*.swift ../ios/Tuna/OfflineStore.swift \
  -o "$APP/Contents/MacOS/Tuna"

# The tunnel for away from home (apps/common/tunnel, Go), next to the app.
GO=$(command -v go || echo /opt/homebrew/bin/go)
(cd ../common/tunnel && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 "$GO" build -trimpath -ldflags "-s -w" -o "$APP/Contents/MacOS/tuna-tunnel" .)

sed "s/__VERSION__/$VERSION/g" Tuna/Info.plist > "$APP/Contents/Info.plist"
# The loading and offline pages are shared with the other apps; the address page is the Mac's own.
cp ../common/loading.html ../common/offline.html Tuna/setup.html "$APP/Contents/Resources/"
# English and Italian: macOS then shows its own menu items, alerts and the local network prompt
# in Italian too when that's your language.
cp -R Tuna/en.lproj Tuna/it.lproj "$APP/Contents/Resources/"

# App icon from the shared artwork.
for size in 16 32 128 256 512; do
  sips -z $size $size ../common/icon.png --out "$BUILD/iconset.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) ../common/icon.png --out "$BUILD/iconset.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$BUILD/iconset.iconset" -o "$APP/Contents/Resources/Tuna.icns"

# iCloud and Finder tag files with metadata that code signing refuses.
xattr -cr "$APP"
codesign --force --sign - "$APP/Contents/MacOS/tuna-tunnel"
codesign --force --sign - "$APP" >/dev/null
echo "Built $APP"

# --selftest: a copy with its own identity (app.tuna.music.selftest), so automated tests never
# touch the real app's sign-in, settings or tunnel.
if [ "${1:-}" = "--selftest" ]; then
  TEST=$BUILD/TunaSelfTest.app
  rm -rf "$TEST"
  cp -R "$APP" "$TEST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier app.tuna.music.selftest" -c "Set :CFBundleName Tuna Self-Test" -c "Set :CFBundleDisplayName Tuna Self-Test" "$TEST/Contents/Info.plist"
  codesign --force --sign - "$TEST" >/dev/null
  echo "Built $TEST"
fi

if [ "${1:-}" = "--dmg" ]; then
  mkdir -p "$BUILD/dmg" ../../release
  cp -R "$APP" "$BUILD/dmg/"
  ln -s /Applications "$BUILD/dmg/Applications"
  rm -f "../../release/Tuna-$VERSION-mac.dmg"
  hdiutil create -volname Tuna -srcfolder "$BUILD/dmg" -ov -format UDZO "../../release/Tuna-$VERSION-mac.dmg" >/dev/null
  echo "Built release/Tuna-$VERSION-mac.dmg"
  # What the app downloads to update itself (Settings → Update, as Tuna-mac.zip): no disk image to mount.
  rm -f "../../release/Tuna-$VERSION-mac.zip"
  ditto -c -k --keepParent "$APP" "../../release/Tuna-$VERSION-mac.zip"
  echo "Built release/Tuna-$VERSION-mac.zip"
fi
