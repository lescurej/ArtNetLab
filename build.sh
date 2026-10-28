#!/bin/bash
set -e

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

APP_NAME="Artnetlab"
APP_PATH="./src-tauri/target/release/bundle/macos/${APP_NAME}.app"

ENABLE_MACOS_SIGN=0
if [ -n "${MACOS_SIGNING_IDENTITY:-}" ]; then
  ENABLE_MACOS_SIGN=1
else
  DETECTED=$(
    security find-identity -v -p codesigning 2>/dev/null |
      awk -F'"' '/Developer ID Application/{print $2; exit}'
  )
  if [ -n "$DETECTED" ]; then
    export MACOS_SIGNING_IDENTITY="$DETECTED"
    ENABLE_MACOS_SIGN=1
  fi
fi

export ENABLE_MACOS_SIGN
node scripts/configure-macos-bundle.mjs

echo "Building Tauri bundle (sign=${ENABLE_MACOS_SIGN})..."
cargo tauri build

DMG_PATH=$(ls ./src-tauri/target/release/bundle/dmg/${APP_NAME}_*.dmg 2>/dev/null | head -n 1)

NOTARIZE_READY=0
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${KEYCHAIN_PROFILE:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  NOTARIZE_READY=1
fi

if [ "$NOTARIZE_READY" != 1 ]; then
  echo "Skipping notarization (set APPLE_ID, APPLE_PASSWORD, KEYCHAIN_PROFILE, APPLE_TEAM_ID in .env to enable)."
  if [ -n "$DMG_PATH" ]; then
    echo "DMG ready: $DMG_PATH"
  fi
  exit 0
fi

if [ ! -d "$APP_PATH" ]; then
  echo "App bundle not found at $APP_PATH"
  exit 1
fi

if [ -z "$DMG_PATH" ]; then
  echo "DMG not found under src-tauri/target/release/bundle/dmg/"
  exit 1
fi

echo "Notarizing with Apple ID $APPLE_ID (team $APPLE_TEAM_ID)..."

if codesign -dv "$APP_PATH" 2>/dev/null; then
  echo "Validating .app signature..."
  spctl -a -vvv "$APP_PATH" || true
  xcrun stapler validate "$APP_PATH" 2>/dev/null || true
fi

echo "Submitting DMG for notarization..."
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "$KEYCHAIN_PROFILE" \
  --wait

echo "Stapling DMG..."
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

echo "Build and notarization complete: $DMG_PATH"
