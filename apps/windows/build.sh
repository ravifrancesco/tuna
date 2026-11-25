#!/bin/bash
# Builds Tuna for Windows (64-bit) into release/Tuna-<version>-windows.exe, an installer.
# Runs on a Mac (or Linux). Needs:
#   - the .NET 8 SDK: https://dot.net, or `curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0`
#   - NSIS: brew install makensis
#   - Go, for the tunnel: brew install go
# Music is played by Windows itself (Windows.Media.Playback), so there's nothing else to download.
set -euo pipefail
cd "$(dirname "$0")"
CACHE="${XDG_CACHE_HOME:-$HOME/Library/Caches}/tuna-build"
# Built from a local copy: macOS won't let .NET clone files kept in iCloud Drive (where this
# project may live), and it keeps build clutter out of iCloud. The installer still lands in release/.
if [ "${TUNA_STAGED:-}" != 1 ]; then
  REPO=$(cd ../.. && pwd)
  WORK="$CACHE/windows"
  mkdir -p "$WORK/apps"
  rsync -a --delete --exclude build ./ "$WORK/apps/windows/"
  rsync -a --delete ../common/ "$WORK/apps/common/"
  cp ../../package.json "$WORK/package.json"
  TUNA_STAGED=1 TUNA_RELEASE="$REPO/release" exec "$WORK/apps/windows/build.sh" "$@"
fi
RELEASE="${TUNA_RELEASE:-../../release}"
VERSION=$(node -p "require('../../package.json').version")
DOTNET=$(command -v dotnet || echo "$HOME/.dotnet/dotnet")
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

mkdir -p build
rm -rf build/publish build/icon

# App icon from the shared artwork (PNG images inside a .ico).
mkdir -p build/icon
for size in 16 24 32 48 64 128 256; do
  sips -z $size $size ../common/icon.png --out "build/icon/$size.png" >/dev/null 2>&1 \
    || magick ../common/icon.png -resize ${size}x${size} "build/icon/$size.png"
done
python3 - build/icon build/Tuna.ico <<'PY'
import struct, sys, os
folder, out = sys.argv[1], sys.argv[2]
sizes = [16, 24, 32, 48, 64, 128, 256]
images = [open(os.path.join(folder, f'{s}.png'), 'rb').read() for s in sizes]
offset = 6 + 16 * len(sizes)
header = struct.pack('<HHH', 0, 1, len(sizes))
entries = b''
for s, data in zip(sizes, images):
    entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
open(out, 'wb').write(header + entries + b''.join(images))
PY

# The app (with its own copy of .NET, so nothing else needs installing).
"$DOTNET" publish Tuna.csproj -c Release -o build/publish -p:Version="$VERSION" --nologo -v quiet
rm -f build/publish/*.pdb build/publish/*.xml
mkdir -p build/publish/licenses
cp THIRD-PARTY.txt build/publish/licenses/
# The loading and offline pages are shared with the other apps; the server address page talks through WebView2.
mkdir -p build/publish/pages
cp ../common/loading.html ../common/offline.html setup.html build/publish/pages/
# The tunnel for away from home (apps/common/tunnel, Go), next to Tuna.exe.
GO=$(command -v go || echo /opt/homebrew/bin/go)
(cd ../common/tunnel && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 "$GO" build -trimpath -ldflags "-s -w" -o "$OLDPWD/build/publish/tuna-tunnel.exe" .)
echo "Built $(pwd)/build/publish/Tuna.exe"

# The installer.
mkdir -p "$RELEASE"
# (makensis crashes without a locale, which shells started by apps often lack.)
LC_ALL="${LC_ALL:-en_US.UTF-8}" makensis -V2 -DVERSION="$VERSION" -DOUTFILE="$RELEASE/Tuna-$VERSION-windows.exe" installer.nsi
echo "Built release/Tuna-$VERSION-windows.exe"
