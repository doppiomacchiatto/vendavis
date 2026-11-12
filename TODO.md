# Vendavis — TODO / Release Checklist

## Before public Beta launch

- [ ] **Code signing — macOS**
  - Obtain an Apple Developer ID Application certificate (requires paid Apple Developer Program membership, ~$99/yr)
  - Add signing config to `src-tauri/tauri.conf.json` under `bundle.macOS`:
    ```json
    "macOS": {
      "signingIdentity": "Developer ID Application: <Your Name> (<TEAM_ID>)",
      "providerShortName": "<TEAM_ID>",
      "entitlements": "entitlements.plist"
    }
    ```
  - Notarize via `xcrun notarytool` after build (or configure Tauri CI action)
  - Without this, macOS Gatekeeper shows "unidentified developer" warning on first launch

- [ ] **Code signing — Windows**
  - Obtain an Authenticode certificate (EV cert recommended to avoid SmartScreen warnings; ~$300-500/yr from DigiCert, Sectigo, etc.)
  - Add to `src-tauri/tauri.conf.json` under `bundle.windows`:
    ```json
    "windows": {
      "certificateThumbprint": "<THUMBPRINT>",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
    ```
  - Without this, Windows SmartScreen shows "Windows protected your PC" warning

- [ ] **Push v1.0.1 Beta to GitHub**
  ```bash
  git push origin opencode/mvp-0
  ```
  (`claude/mvp-0` is archived; `opencode/mvp-0` is the single dev branch. See README "Branching and releases".)

## MVP-1 features (post-Beta)

- [ ] **Excel template import → deploy Profile/PermSet**
  - Backend: new endpoint `POST /api/orgs/{alias}/deploy-permset`
  - Accepts the Excel template exported from FLS Explorer / Profiles tab
  - Parses rows (object/field/record type) × columns (profile/perm set name) → builds Metadata API XML
  - Deploys via `sf project deploy start` or direct Metadata API call
  - Frontend: "Import & Deploy" button in FLS Explorer and Profiles & PermSets tab

- [ ] **ClaudeChat.jsx console.error cleanup** (line ~436, fires on stream abort — benign but noisy)

## Notes

- Signing is **not blocking** for internal/beta distribution — testers can right-click → Open on macOS or click "More info → Run anyway" on Windows
- Signing config goes on `opencode/mvp-0` (the single dev branch); `claude/mvp-0` is archived
