#!/bin/bash
# Builds the iPhone & iPad app into release/Tuna-<version>-ios.ipa, unsigned: AltStore and
# SideStore sign it with the person's own Apple ID when they install it. Needs Xcode, and Go
# (brew install go) for the tunnel.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
WORK="${XDG_CACHE_HOME:-$HOME/Library/Caches}/tuna-build/ios"
APP="$WORK/DerivedData/Build/Products/Release-iphoneos/Tuna.app"
LOG="$WORK/xcodebuild.log"
# The last build's app goes first, so a build that fails can't be packaged in its place.
rm -rf "$WORK/Payload" "$APP"
mkdir -p "$WORK"
if ! xcodebuild -project apps/ios/Tuna.xcodeproj -scheme Tuna -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -derivedDataPath "$WORK/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" MARKETING_VERSION="$VERSION" \
  build -quiet >"$LOG" 2>&1; then
  grep -E "error:" "$LOG" || tail -n 30 "$LOG"
  echo "The iPhone app didn't build (everything Xcode said: $LOG)" >&2
  exit 1
fi
mkdir -p "$WORK/Payload" release
cp -R "$APP" "$WORK/Payload/"
rm -f "release/Tuna-$VERSION-ios.ipa"
(cd "$WORK" && zip -q -r -y "$OLDPWD/release/Tuna-$VERSION-ios.ipa" Payload)
echo "Built release/Tuna-$VERSION-ios.ipa"
