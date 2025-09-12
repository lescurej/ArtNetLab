#!/bin/bash
set -e

# Load environment variables from .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
else
  echo ".env file not found. Please create one with APPLE_ID, APPLE_PASSWORD, KEYCHAIN_PROFILE, and APPLE_TEAM_ID."
  exit 1
fi

APP_NAME="Artnetlab"
APP_PATH="./src-tauri/target/release/bundle/macos/${APP_NAME}.app"
DMG_PATH=$(ls ./src-tauri/target/release/bundle/dmg/${APP_NAME}_*.dmg | head -n 1)

echo "🔐 Using Apple ID: $APPLE_ID"
echo "🏷️  Team ID: $APPLE_TEAM_ID"
echo "🔑 Keychain profile: $KEYCHAIN_PROFILE"
echo "🔑 APPLE_PASSWORD: $APPLE_PASSWORD"
echo "🚀 Building with Tauri..."

# Build and notarize the .app bundle
cargo tauri build

# Validate .app
echo "🔍 Validating .app signature..."
spctl -a -vvv "$APP_PATH"

echo "📎 Validating .app notarization ticket..."
xcrun stapler validate "$APP_PATH"

# Notarize DMG
echo "📤 Submitting DMG for notarization..."
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "$KEYCHAIN_PROFILE" \
  --wait

# Staple and validate DMG
echo "📎 Stapling DMG ticket..."
xcrun stapler staple "$DMG_PATH"

echo "🔍 Validating DMG ticket..."
xcrun stapler validate "$DMG_PATH"

echo "✅ Build, sign, and notarization complete for .app and .dmg!"
