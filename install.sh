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
git clone --depth 1 --branch v2.4.0 https://github.com/koompi/jrok.git
cd jrok/cli

echo -e "${YELLOW}→${NC} Installing dependencies..."
npm install --silent

echo -e "${YELLOW}→${NC} Building CLI..."
npm run build --silent

echo -e "${YELLOW}→${NC} Creating package..."
PKG_FILE=$(npm pack --silent)

echo -e "${YELLOW}→${NC} Installing globally..."
npm install -g "$PKG_FILE" --silent
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   Installation Complete! 🎉                          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Run ${GREEN}jrok --help${NC} to get started"
echo -e "Run ${GREEN}jrok --port 3000${NC} to expose your local server"
echo ""
