#!/bin/bash
# Builds the iPhone & iPad app into release/Tuna-<version>-ios.ipa, unsigned: AltStore and
# SideStore sign it with the person's own Apple ID when they install it. Needs Xcode.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
WORK="${XDG_CACHE_HOME:-$HOME/Library/Caches}/tuna-build/ios"
rm -rf "$WORK/Payload"
xcodebuild -project apps/ios/Tuna.xcodeproj -scheme Tuna -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -derivedDataPath "$WORK/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" MARKETING_VERSION="$VERSION" \
  build -quiet 2>&1 | grep -E "error:" | grep -v "exit code 0" || true
mkdir -p "$WORK/Payload" release
cp -R "$WORK/DerivedData/Build/Products/Release-iphoneos/Tuna.app" "$WORK/Payload/"
rm -f "release/Tuna-$VERSION-ios.ipa"
(cd "$WORK" && zip -q -r -y "$OLDPWD/release/Tuna-$VERSION-ios.ipa" Payload)
echo "Built release/Tuna-$VERSION-ios.ipa"
