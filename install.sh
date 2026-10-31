#!/usr/bin/env bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   Jrok CLI Installer                                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed.${NC}"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm is not installed.${NC}"
    echo "Please install npm"
    exit 1
fi

echo -e "${YELLOW}→${NC} Checking Node.js version..."
NODE_VERSION=$(node -v)
echo -e "${GREEN}✓${NC} Node.js $NODE_VERSION"

# Create temp directory
TEMP_DIR=$(mktemp -d)
echo -e "${YELLOW}→${NC} Downloading Jrok CLI..."

# Clone the repository
cd "$TEMP_DIR"
git clone --depth 1 --branch v2.6.5 https://github.com/koompi/jrok.git
cd jrok/cli

echo -e "${YELLOW}→${NC} Installing dependencies..."
npm install --silent

echo -e "${YELLOW}→${NC} Building CLI..."
npm run build --silent

echo -e "${YELLOW}→${NC} Creating package..."
PKG_FILE=$(npm pack --silent)

echo -e "${YELLOW}→${NC} Installing globally..."
npm install -g "$PKG_FILE" --silent

# jrok-connector (connector/): one process carrying every tunnel on a KConsole
# deploy-worker host, which uses it instead of a `jrok` process per tunnel when
# it is on PATH. Built here, with cargo or else in Docker (every deploy worker
# has it). JROK_CONNECTOR=skip leaves it out.
if [ "${JROK_CONNECTOR:-}" != "skip" ]; then
    cd "$TEMP_DIR/jrok/connector"
    BUILT=""
    if command -v cargo &> /dev/null; then
        echo -e "${YELLOW}→${NC} Building jrok-connector (cargo)..."
        cargo build --release --locked --quiet && BUILT=target/release/jrok-connector
    elif command -v docker &> /dev/null; then
        echo -e "${YELLOW}→${NC} Building jrok-connector (Docker, a few minutes the first time)..."
        # Bullseye: glibc 2.31, so the binary runs on Ubuntu 20.04 and later.
        docker run --rm -v "$PWD":/src -w /src rust:1.93-slim-bullseye \
            sh -c 'cargo build --release --locked --quiet && chown -R '"$(id -u):$(id -g)"' target' \
            && BUILT=target/release/jrok-connector
        docker rmi rust:1.93-slim-bullseye > /dev/null 2>&1 || true
    fi
    if [ -n "$BUILT" ]; then
        BIN_DIR="$(npm prefix -g)/bin"
        if [ -w "$BIN_DIR" ]; then install -m 755 "$BUILT" "$BIN_DIR/jrok-connector"; else sudo install -m 755 "$BUILT" "$BIN_DIR/jrok-connector"; fi
        echo -e "${GREEN}✓${NC} $("$BIN_DIR/jrok-connector" --version) in $BIN_DIR"
    else
        echo -e "${YELLOW}!${NC} jrok-connector not built (no cargo or Docker); deploy workers fall back to a jrok process per tunnel"
    fi
fi
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   Installation Complete! 🎉                          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Run ${GREEN}jrok --help${NC} to get started"
echo -e "Run ${GREEN}jrok --port 3000${NC} to expose your local server"
echo ""
