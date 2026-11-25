#!/bin/bash
# Builds the Android app (phones, tablets, Fire TV, Android TV) into release/Tuna-<version>-android.apk.
# --debug builds the test copy (app.tuna.music.debug) into release/Tuna-<version>-android-debug.apk.
# Needs a JDK (17+), Go, and the Android SDK (sdk.dir in apps/android/local.properties).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
KIND=release
[ "${1:-}" = "--debug" ] && KIND=debug
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/java" ]; then
  if [ -d "$(brew --prefix 2>/dev/null)/opt/openjdk@21" ]; then
    export JAVA_HOME="$(brew --prefix)/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
  fi
fi
# Built from a local copy: macOS won't let Gradle clone files kept in iCloud Drive (where this
# project may live), and it keeps build clutter out of iCloud.
WORK="${XDG_CACHE_HOME:-$HOME/Library/Caches}/tuna-build/android"
mkdir -p "$WORK/apps"
rsync -a --delete --exclude build --exclude .gradle apps/android/ "$WORK/apps/android/"
rsync -a --delete apps/common/ "$WORK/apps/common/"
TASK=assembleRelease
[ "$KIND" = debug ] && TASK=assembleDebug
(cd "$WORK/apps/android" && ./gradlew "$TASK" --console=plain -q)
mkdir -p release
NAME="Tuna-$VERSION-android.apk"
[ "$KIND" = debug ] && NAME="Tuna-$VERSION-android-debug.apk"
cp "$WORK/apps/android/app/build/outputs/apk/$KIND/app-$KIND.apk" "release/$NAME"
echo "Built release/$NAME"
