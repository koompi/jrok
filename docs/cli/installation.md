# CLI Installation

Install the KProxy CLI to expose your local services to the internet.

## Quick Install

### macOS / Linux

```bash
# Download latest release
curl -fsSL https://github.com/koompi/jrok/releases/latest/download/kproxy-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m) -o kproxy

# Make executable
chmod +x kproxy

# Move to PATH
sudo mv kproxy /usr/local/bin/

# Verify installation
kproxy version
```

### npm / Bun

```bash
# Using npm
curl -fsSL https://raw.githubusercontent.com/koompi/jrok/v2.1.0/install.sh | bash

# Using Bun
bun install -g kproxy

# Verify
kproxy version
```

### Windows

```powershell
# Download from releases
Invoke-WebRequest -Uri "https://github.com/koompi/jrok/releases/latest/download/kproxy-windows-x64.exe" -OutFile "kproxy.exe"

# Move to PATH (e.g., C:\Program Files\kproxy\)
Move-Item kproxy.exe "C:\Program Files\kproxy\"

# Add to PATH (run as Administrator)
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\Program Files\kproxy", [EnvironmentVariableTarget]::Machine)

# Verify
kproxy version
```

## Build from Source

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- Node.js 18+ (for npm)
- Git

### Build Steps

```bash
# Clone repository
git clone https://github.com/koompi/jrok.git
cd jrok/cli

# Install dependencies
bun install

# Build
bun run build.sh

# Binary is in cli/bin/
./bin/kproxy version
```

### Development Mode

```bash
cd cli

# Run directly with Bun
bun run src/index.ts --help

# Or with ts-node
npx ts-node src/index.ts --help
```

## First Time Setup

### 1. Get an API Key

**Option A: Use KOOMPI Cloud (Managed)**
1. Visit [live.koompi.cloud](https://live.koompi.cloud)
2. Sign in with KOOMPI ID
3. Create or select an organization
4. Generate an API key

**Option B: Self-Hosted**
1. Access your KProxy dashboard
2. Sign in and create an API key

### 2. Configure CLI

```bash
# Interactive setup (recommended)
kproxy --port 3000
# You'll be prompted for your API key

# Or configure manually
kproxy config --server https://live.koompi.cloud --auth kproxy_your_api_key
```

### 3. Start Tunneling!

```bash
kproxy --port 3000
```

## Verify Installation

```bash
# Check version
kproxy version

# Expected output:
# kproxy v2.3.0
# Node v20.x.x

# Show help
kproxy help

# Check configuration
kproxy config
```

## Updating

### npm / Bun

```bash
npm update -g kproxy
# or
bun update -g kproxy
```

### Binary

```bash
# Download and replace
curl -fsSL https://github.com/koompi/jrok/releases/latest/download/kproxy-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m) -o /usr/local/bin/kproxy
chmod +x /usr/local/bin/kproxy
```

## Uninstalling

### npm / Bun

```bash
npm uninstall -g kproxy
```

> A legacy `~/.jrok` config directory is still read for backward compatibility; new installs
> use `~/.kproxy`.

### Binary

```bash
sudo rm /usr/local/bin/kproxy
rm -rf ~/.kproxy  # Remove config
```

---

## Platform-Specific Notes

### macOS

If you get "cannot be opened because the developer cannot be verified":
```bash
xattr -d com.apple.quarantine /usr/local/bin/kproxy
```

### Linux

Ensure the binary has execute permissions:
```bash
chmod +x /usr/local/bin/kproxy
```

### Windows

Run PowerShell as Administrator for PATH modifications.

---

## Next Steps

- [CLI Commands](./commands.md) - Full command reference
- [Quick Start](../getting-started/quick-start.md) - Expose your first service
