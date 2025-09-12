Release CI with GitHub Actions (Tauri v2)

This project includes a GitHub Actions workflow that:
- Builds macOS (DMG), Windows, and Linux installers
- Signs and notarizes the macOS build
- Publishes a GitHub Release when pushing a tag like `v0.1.0`

Trigger a release
- Push a git tag matching `v*` (e.g., `v0.1.0`).
  The workflow will build all targets and attach artifacts to the release.

Required GitHub Secrets
- APPLE_ID: Apple Developer account email.
- APPLE_PASSWORD: App-specific password for notarization (not your Apple password).
- APPLE_TEAM_ID: Your Apple Team ID (e.g., `92RUVKH33H`).
- MACOS_CERT_P12: Base64-encoded Developer ID Application certificate (.p12).
- MACOS_CERT_PASSWORD: Password for the .p12 certificate.

Optional (if you plan to sign Windows builds)
- WINDOWS_CERT_PFX: Base64-encoded code-signing certificate (.pfx).
- WINDOWS_CERT_PASSWORD: Password for the .pfx certificate.

Notes
- The workflow uses `tauri-apps/tauri-action` to build and publish artifacts.
- macOS signing identity should match `bundle.macOS.signingIdentity` in `src-tauri/tauri.conf.json`.
- Linux uses system dependencies like `libwebkit2gtk-4.1-dev`; the workflow installs them on Ubuntu.
- Windows uses WiX Toolset for MSI packaging; the workflow installs it via Chocolatey.

Local macOS build & notarization
- You can continue to use `./build.sh` locally. It expects `.env` values for Apple credentials and a configured keychain profile for `notarytool`.

