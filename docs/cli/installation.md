# CLI Installation

Install the `kproxy` CLI to expose your local services to the internet.

## npm (recommended)

```bash
npm install -g kproxy
kproxy --version
```

Works with Node.js 18+. `npx kproxy http 3000` also works without installing.

## Standalone binary (no Node required)

Download the prebuilt binary for your platform from the
[releases page](https://github.com/koompi/jrok/releases/latest), or build one yourself:

```bash
git clone https://github.com/koompi/jrok.git
cd jrok/cli
npm install
npm run bundle          # -> bin/kproxy-standalone
sudo mv bin/kproxy-standalone /usr/local/bin/kproxy
kproxy --version
```

## Build from source

```bash
git clone https://github.com/koompi/jrok.git
cd jrok/cli
npm install
npm run build           # bundles dist/index.js
node dist/index.js --version

# develop against source
npm run dev -- http 3000
npm run typecheck
npm test
```

## First-time setup

```bash
# Browser login (device flow) — points the CLI at your server and stores a key
kproxy login --server https://live.example.com

# …or configure a key manually (CI / headless)
kproxy config --server https://live.example.com --auth kproxy_your_api_key
```

Then:

```bash
kproxy http 3000
```

## Verify

```bash
kproxy --version
kproxy --help
kproxy config            # show the effective server / org / key
kproxy doctor            # check connectivity + auth
```

## Update

```bash
npm update -g kproxy
```

## Uninstall

```bash
npm uninstall -g kproxy
rm -rf ~/.kproxy          # remove stored config
```

## Platform notes

- **macOS** (binary blocked by Gatekeeper): `xattr -d com.apple.quarantine /usr/local/bin/kproxy`
- **Linux** (binary): `chmod +x /usr/local/bin/kproxy`
- **Windows**: run PowerShell as Administrator when adding to `PATH`.

---

## Next steps
- [Quick Start](../getting-started/quick-start.md) — expose your first service
- [CLI Commands](./commands.md) — the full command reference
