# Bundled XMRig Assets

This directory contains CLI-managed XMRig binaries. Users should not install or
run XMRig manually.

Current bundled dev asset:

```text
darwin-arm64/xmrig
XMRig 6.26.0
Mach-O 64-bit executable arm64
sha256 c66f9881bed79a550e18d54b9ae5cf03b91a0e881efdbf7962db2e58de0b4f7b
```

Source for this local commit:

```text
/private/tmp/xpool-lab/xmrig-6.26.0/xmrig
```

This is enough for local macOS arm64 E2E testing. It is not the final production
packaging story.

Known behavior in local E2E: this macOS arm64 binary exits after CLI stop, but
logs a libuv assertion during signal shutdown. The miner process does not remain
running. Treat this as a dev-binary issue to resolve before production
packaging.

Before production release:

- build or fetch pinned XMRig binaries for every supported platform
- verify and record checksums
- decide donation policy and build from source if donation must be disabled
- handle macOS signing/notarization
- keep GPL distribution obligations explicit
