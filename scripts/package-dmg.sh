#!/bin/bash
set -euo pipefail

fail() {
  echo "$*" >&2
  exit 1
}

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(plutil -extract version raw -- "$root/package.json")
name="Calendar Hub"
filename="Calendar-Hub-$version-arm64.dmg"
packaged="$root/build/packaged/$name-darwin-arm64"
release="$root/build/release"
lock=''

case $# in
  0)
    mkdir -p "$release"
    work=$(mktemp -d "$release/.dmg.XXXXXXXX")
    ;;
  2)
    [[ $1 == --verify && -f $2 ]] || fail "Usage: $0 [--verify <disk image>]"
    work=$(mktemp -d "${TMPDIR:-/tmp}/calendar-hub-verify.XXXXXXXX")
    ;;
  *) fail "Usage: $0 [--verify <disk image>]" ;;
esac

mountpoint="$work/mounted"
cleanup() {
  if [[ -d "$mountpoint" && $(stat -f %d "$mountpoint") != "$(stat -f %d "$work")" ]]; then
    hdiutil detach "$mountpoint" -quiet || hdiutil detach "$mountpoint" -force -quiet || {
      echo "Could not detach the disk image at $mountpoint" >&2
      exit 1
    }
  fi
  rm -rf "$work"
  if [[ -n $lock ]]; then rm -f "$lock"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

check_plist() {
  local actual
  actual=$(plutil -extract "$2" raw -- "$1")
  [[ $actual == "$3" ]] || fail "Expected $2 to be '$3', got '$actual'."
}

check_arm64() {
  [[ -x "$1" && $(lipo -archs "$1") == arm64 ]] || fail "Expected an arm64 executable at $1"
}

verify_image() {
  local app="$mountpoint/$name.app" plist helper helper_name signature
  hdiutil verify "$1" -quiet
  mkdir "$mountpoint"
  hdiutil attach "$1" -readonly -nobrowse -noautoopen -mount required -mountpoint "$mountpoint" -quiet
  [[ -L "$mountpoint/Applications" && $(readlink "$mountpoint/Applications") == /Applications ]] ||
    fail "Expected an Applications link pointing to /Applications."
  [[ -d "$app" && ! -L "$app" ]] || fail "Missing $name.app"
  plist="$app/Contents/Info.plist"
  check_plist "$plist" CFBundleIdentifier local.calendarcentral.desktop
  check_plist "$plist" CFBundleShortVersionString "$version"
  check_plist "$plist" CFBundleVersion "$version"
  check_plist "$plist" CFBundleExecutable "$name"
  check_plist "$plist" LSMinimumSystemVersion 14.0

  check_arm64 "$app/Contents/MacOS/$name"
  check_arm64 "$app/Contents/Frameworks/Electron Framework.framework/Electron Framework"
  for helper in "$app"/Contents/Frameworks/*.app; do
    helper_name=$(plutil -extract CFBundleExecutable raw -- "$helper/Contents/Info.plist")
    check_arm64 "$helper/Contents/MacOS/$helper_name"
  done
  for helper in "$app/Contents/Resources/calendar-mac" "$app/Contents/Resources/calendar-notifications.node"; do
    check_arm64 "$helper"
    codesign --verify --strict "$helper"
    [[ $(xcrun vtool -show-build "$helper" | awk '$1 == "minos" {print $2}') == 14.0 ]] ||
      fail "Expected a macOS 14.0 build target for $helper"
  done
  [[ -s "$app/Contents/Resources/app.asar" ]] || fail "Missing application archive."
  [[ -s "$mountpoint/Licenses/LICENSE" && -s "$mountpoint/Licenses/LICENSES.chromium.html" ]] ||
    fail "Missing Electron or Chromium license notices."
  codesign --verify --deep --strict "$app"
  signature=$(codesign --display --verbose=2 "$app" 2>&1)
  grep -Fxq 'Signature=adhoc' <<< "$signature" || fail "Expected an ad-hoc signature."
  hdiutil detach "$mountpoint" -quiet
}

if [[ $# == 2 ]]; then
  verify_image "$2"
  echo "Verified $2"
  exit 0
fi

shlock -f "$release/.$filename.lock" -p "$$" || fail "Another process is building $filename."
lock="$release/.$filename.lock"
[[ -d "$packaged/$name.app" ]] || fail "Run npm run package:mac on Apple Silicon first."
mkdir -p "$work/installer/Licenses"
ditto "$packaged/$name.app" "$work/installer/$name.app"
cp "$packaged/LICENSE" "$packaged/LICENSES.chromium.html" "$work/installer/Licenses/"
ln -s /Applications "$work/installer/Applications"
hdiutil create -srcfolder "$work/installer" -volname "$name" -fs HFS+ -format UDZO -nospotlight "$work/$filename"
verify_image "$work/$filename"
(cd "$work" && shasum -a 256 "$filename" > "$filename.sha256")
mv -f "$work/$filename" "$work/$filename.sha256" "$release/"
echo "$release/$filename"
echo "$release/$filename.sha256"
