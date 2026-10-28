Release CI with GitHub Actions (Tauri v2)

This project includes a GitHub Actions workflow that:
- Builds macOS (DMG), Windows, and Linux installers
- Optionally signs and notarizes the macOS build when secrets are configured
- Publishes a GitHub Release when pushing a tag like `v0.1.0`

Trigger a release
- Push a git tag matching `v*` (e.g., `v0.1.0`).
  The workflow will build all targets and attach artifacts to the release.

macOS without notarization
- The DMG is always produced on macOS runners.
- Notarization runs only when **all three** secrets are set: `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
- Do not add those env vars with empty values; the workflow uses two build steps so notarization is truly skipped when secrets are missing.
- Code signing is optional: set `MACOS_CERT_P12` and `MACOS_CERT_PASSWORD`, plus optional `MACOS_SIGNING_IDENTITY`. Without a certificate, the bundle is unsigned (users may need Right-click → Open).

Required GitHub Secrets (macOS signing, optional)
- MACOS_CERT_P12: Base64-encoded Developer ID Application certificate (.p12).
- MACOS_CERT_PASSWORD: Password for the .p12 certificate.
- MACOS_SIGNING_IDENTITY: Full identity string (optional if detectable after import).

Required GitHub Secrets (macOS notarization, optional)
- APPLE_ID: Apple Developer account email.
- APPLE_PASSWORD: App-specific password for notarization.
- APPLE_TEAM_ID: Apple Team ID.

Optional (Windows code signing)
- WINDOWS_CERT_PFX: Base64-encoded code-signing certificate (.pfx).
- WINDOWS_CERT_PASSWORD: Password for the .pfx certificate.

Notes
- `scripts/configure-macos-bundle.mjs` sets `bundle.macOS.signingIdentity` only when signing is enabled.
- The tag version is injected into `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` before bundling.
- Linux uses system dependencies like `libwebkit2gtk-4.1-dev`; the workflow installs them on Ubuntu.
- Windows uses WiX Toolset for MSI packaging; the workflow installs it via Chocolatey.

Local macOS build
- `./build.sh` builds a DMG without requiring `.env`.
- Notarization runs only when `.env` contains `APPLE_ID`, `APPLE_PASSWORD`, `KEYCHAIN_PROFILE`, and `APPLE_TEAM_ID`.
- Optional `MACOS_SIGNING_IDENTITY` in `.env` enables Developer ID signing when a certificate is in the keychain.
