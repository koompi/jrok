# CLI Installation

Install the Jrok CLI to expose your local services to the internet.

## Quick Install

### macOS / Linux

```bash
# Download latest release
curl -fsSL https://github.com/koompi/jrok/releases/latest/download/jrok-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m) -o jrok

# Make executable
chmod +x jrok

# Move to PATH
sudo mv jrok /usr/local/bin/

# Verify installation
jrok version
```

### npm / Bun

```bash
# Using npm
curl -fsSL https://raw.githubusercontent.com/koompi/jrok/v2.1.0/install.sh | bash

# Using Bun
bun install -g @koompi/jrok

# Verify
jrok version
```

### Windows

```powershell
# Download from releases
Invoke-WebRequest -Uri "https://github.com/koompi/jrok/releases/latest/download/jrok-windows-x64.exe" -OutFile "jrok.exe"

# Move to PATH (e.g., C:\Program Files\jrok\)
Move-Item jrok.exe "C:\Program Files\jrok\"

# Add to PATH (run as Administrator)
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\Program Files\jrok", [EnvironmentVariableTarget]::Machine)

# Verify
jrok version
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
./bin/jrok version
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
1. Visit [tunnel.koompi.cloud](https://tunnel.koompi.cloud)
2. Sign in with KOOMPI ID
3. Create or select an organization
4. Generate an API key

**Option B: Self-Hosted**
1. Access your Jrok dashboard
2. Sign in and create an API key

### 2. Configure CLI

```bash
# Interactive setup (recommended)
jrok --port 3000
# You'll be prompted for your API key

# Or configure manually
jrok config --server https://tunnel.koompi.cloud --auth jrok_your_api_key
```

### 3. Start Tunneling!

```bash
jrok --port 3000
```

## Verify Installation

```bash
# Check version
jrok version

# Expected output:
# jrok v2.4.0
# Node v20.x.x

# Show help
jrok help

# Check configuration
jrok config
```

## Updating

### npm / Bun

```bash
npm update -g @koompi/jrok
# or
bun update -g @koompi/jrok
```

### Binary

```bash
# Download and replace
curl -fsSL https://github.com/koompi/jrok/releases/latest/download/jrok-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m) -o /usr/local/bin/jrok
chmod +x /usr/local/bin/jrok
```

## Uninstalling

### npm / Bun

```bash
npm uninstall -g @koompi/jrok
```

### Binary

```bash
sudo rm /usr/local/bin/jrok
rm -rf ~/.jrok  # Remove config
```

---

## Platform-Specific Notes

### macOS

If you get "cannot be opened because the developer cannot be verified":
```bash
xattr -d com.apple.quarantine /usr/local/bin/jrok
```

### Linux

Ensure the binary has execute permissions:
```bash
chmod +x /usr/local/bin/jrok
```

### Windows

Run PowerShell as Administrator for PATH modifications.

---

## Next Steps

- [CLI Commands](./commands.md) - Full command reference
- [CLI Configuration](./configuration.md) - Advanced configuration
