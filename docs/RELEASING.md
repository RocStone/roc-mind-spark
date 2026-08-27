# Releasing

This checklist is for repository maintainers. Releases are created manually after explicit owner approval; CI tests and packages the tree but never publishes, tags, signs with a Developer ID, or notarizes.

## v1.0.0 distribution decision

Version 1.0.0 is the first formal GitHub Release in the existing public repository. The owner accepted the repository's existing Git history and chose this distribution:

- macOS 14+ on Apple Silicon only
- `Roc-Mind-Spark-v1.0.0-macos-arm64.zip` plus its `.sha256` file
- external Node.js 22.13.0+ runtime; Node is not bundled
- ad-hoc code signature, no Developer ID certificate, and no Apple notarization
- expected first-launch Gatekeeper block, documented with the user-controlled **Open Anyway** flow

The arm64 ZIP cannot run on Intel Macs. Do not describe the App as Apple-verified, notarized, universally compatible, or installer-based.

## Build only from the release commit

Do not publish an old or provenance-unknown file already sitting in `dist/`. First commit the release tree, then build and verify that exact commit with a clean working tree:

```bash
git status --short
make test
make release-archive
```

`make release-archive` performs a release Swift build, packages and ad-hoc signs `dist/Roc Mind Spark.app`, confirms the binary is arm64, and writes:

```text
dist/Roc-Mind-Spark-v1.0.0-macos-arm64.zip
dist/Roc-Mind-Spark-v1.0.0-macos-arm64.zip.sha256
```

The ZIP is created with macOS `ditto --keepParent --sequesterRsrc`, so the App bundle remains intact. The checksum is the SHA-256 of the final ZIP bytes, not a code-signing CDHash.

## Verify the App and archive

Set these shell variables before running the checks:

```bash
APP="dist/Roc Mind Spark.app"
BIN="$APP/Contents/MacOS/RocMindSpark"
ZIP="dist/Roc-Mind-Spark-v1.0.0-macos-arm64.zip"
SUM="$ZIP.sha256"
```

Verify version, platform, architecture, signature integrity, notices, and checksum:

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist"
lipo -archs "$BIN"
codesign --verify --deep --strict "$APP"
codesign -dv --verbose=4 "$APP"
test -f "$APP/Contents/Resources/LICENSE"
test -f "$APP/Contents/Resources/NOTICE"
(cd dist && shasum -a 256 -c "$(basename "$SUM")")
```

For v1.0.0 the expected values are version `1.0.0`, build `1`, minimum macOS `14.0`, architecture `arm64`, and an ad-hoc signature with no Team ID. This assessment is also expected to fail because the App is not notarized:

```bash
spctl --assess --type execute --verbose=4 "$APP"
```

Record that failure honestly; it is not evidence that Apple approved the binary. The README's checksum and **Open Anyway** instructions are part of this release strategy.

Extract the ZIP into a newly created temporary directory and repeat the architecture, plist, signature, LICENSE, and NOTICE checks on the extracted App. Also inspect the App and ZIP file list for material that must not ship:

- `Archive/` or local `AGENTS.md`
- `web/data/*.db`, user maps, images, or logs
- `.env` files, API keys, OAuth credentials, or personal payment identifiers
- private screenshots or developer checkout paths such as `/Users/<name>/...`

## Runtime acceptance

Run `make install`; this replaces the hotkey-launched App with the current build. Complete these checks on an Apple Silicon Mac:

1. The App launches, the menu-bar item appears, and **⌃⌥⇧⌘Q** shows the canvas.
2. `lsof -nP -iTCP:3034 -sTCP:LISTEN` reports `127.0.0.1:3034`, never a LAN bind.
3. Maps save under `~/Library/Application Support/RocMindSpark/`.
4. A foreign listener on 3034 remains alive; the App shows a port error and recovers after the user frees the port and clicks **Retry**.
5. A second `make install` sends SIGTERM to the installed App, AppKit runs `applicationWillTerminate`, the held Node process exits, and the replacement App starts with a new App PID and Node PID.
6. English and Chinese startup errors, settings, and menu-bar strings remain usable.

Where available, repeat first-launch acceptance on a clean Apple Silicon Mac: verify the downloaded checksum, move the App from the ZIP to `/Applications`, confirm Gatekeeper blocks it, and confirm **System Settings → Privacy & Security → Open Anyway** permits launch. A managed Mac can forbid this override.

## Publish and verify

After all source changes are committed and the archive has been rebuilt from that commit:

1. Push `main` without force-pushing.
2. Create annotated tag `v1.0.0` on the verified release commit and push the tag.
3. Create GitHub Release **Roc Mind Spark v1.0.0** from that tag.
4. Upload the ZIP and its `.sha256` file.
5. Put the final ZIP byte size, SHA-256 digest, tag, and commit in the release notes. Keep the Apple Silicon, Node.js, signing, notarization, and Gatekeeper warning above the feature list.
6. Download both assets from GitHub into a temporary directory and run `shasum -a 256 -c` again.
7. Confirm the remote tag points to the verified commit, the direct links work, and the GitHub Actions run for that commit is green.

Future releases can replace the manual Gatekeeper flow with a Developer ID Application signature and Apple notarization. That requires an Apple Developer Program membership, a suitable certificate, notarization credentials, `notarytool`, stapling, and a clean-Mac acceptance pass. Do not claim that path until all of it is implemented and verified.
