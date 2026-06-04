# Bundled XMRig Assets

This directory contains CLI-managed XMRig binaries. Users should not install or
run XMRig manually.

Current bundled asset:

```text
darwin-arm64/xmrig
XMRig 6.26.0
Mach-O 64-bit executable arm64
source tag v6.26.0
source commit b2ca72480c58d197e18c885d9fc1a0c8d517e60a
patch patches/disable-donation.patch
sha256 abcfb8818acafe7b3bb2d80cb7a9e44c6f366b299c24b92938c2250be3950646
```

Build command:

```bash
DRIP_XMRIG_PLATFORM=darwin-arm64 scripts/package-xmrig.sh
```

The build script clones the official `xmrig/xmrig` source at `v6.26.0`, checks
the expected release commit, applies the donation-disable patch, builds from
source, installs the binary into the matching platform directory, and writes a
`SHA256SUMS` file.

Local E2E verification on macOS arm64:

```text
DONATE 0%
accepted shares through xpool-gate
drip stop exits without the previous libuv signal-shutdown assertion
```

The previous bundled binary was the official prebuilt `xmrig-6.26.0-macos-arm64`
archive. Its archive checksum matched the official release checksum, but it
logged a libuv assertion during signal shutdown and kept the upstream default
donation behavior. Do not use official prebuilt binaries for production `drip`
packages if donation must be disabled.

Supported build-script targets:

```text
darwin-arm64
darwin-amd64
linux-amd64
windows-amd64
```

The `Package XMRig` workflow currently builds source-patched macOS arm64 and
Linux amd64 artifacts. macOS amd64 remains script-supported, but is not in the
required CI matrix because GitHub-hosted Intel macOS runner availability can
leave jobs queued for a long time. Windows packaging still needs a native
Windows dependency path before it should be treated as release-ready.

The `Package drip` workflow wraps the matching `drip` binary and XMRig binary
into a release archive:

```text
drip
third_party/xmrig/<platform>/xmrig
third_party/xmrig/<platform>/SHA256SUMS
README.txt
```

Before production release:

- run the packaging workflows for every supported platform
- verify and record checksums from each produced `SHA256SUMS`
- make Linux packaging static or document runtime library dependencies
- handle macOS signing/notarization
- keep GPL distribution obligations explicit
