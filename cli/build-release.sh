#!/usr/bin/env bash
set -e

echo "🔨 Building JROK CLI for all platforms..."

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Clean previous builds
echo -e "${BLUE}Cleaning previous builds...${NC}"
rm -rf dist/ bin/kproxy-*

# Create directories
mkdir -p dist bin

# Build JS bundle using esbuild for proper CommonJS output (pkg compatible)
echo -e "${BLUE}Building JavaScript bundle...${NC}"
npx esbuild src/index.ts \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=cjs \
  --outfile=dist/index.js \
  --minify \
  --external:fsevents
echo -e "${GREEN}✓ JavaScript bundle created${NC}"

# Build for all platforms using pkg
echo -e "${BLUE}Building binaries for all platforms...${NC}"
echo -e "${YELLOW}This may take a few minutes...${NC}"

npx @yao-pkg/pkg dist/index.js \
  --targets node18-linux-x64,node18-macos-x64,node18-win-x64 \
  --output bin/kproxy \
  --compress GZip

# Rename files with proper extensions
echo -e "${BLUE}Renaming binaries...${NC}"

if [ -f "bin/kproxy-linux" ]; then
  mv bin/kproxy-linux bin/kproxy-linux-x64
  chmod +x bin/kproxy-linux-x64
  echo -e "${GREEN}✓ Linux binary: bin/kproxy-linux-x64${NC}"
fi

if [ -f "bin/kproxy-macos" ]; then
  mv bin/kproxy-macos bin/kproxy-macos-x64
  chmod +x bin/kproxy-macos-x64
  echo -e "${GREEN}✓ macOS binary: bin/kproxy-macos-x64${NC}"
fi

if [ -f "bin/kproxy-win.exe" ]; then
  mv bin/kproxy-win.exe bin/kproxy-windows-x64.exe
  echo -e "${GREEN}✓ Windows binary: bin/kproxy-windows-x64.exe${NC}"
fi

# Show file sizes
echo ""
echo -e "${GREEN}✨ Build complete!${NC}"
echo ""
echo "Binary sizes:"
ls -lh bin/kproxy-* 2>/dev/null | awk '{print "  " $9 ": " $5}'

echo ""
echo "Test binaries:"
echo "  Linux:   ./bin/kproxy-linux-x64 version"
echo "  macOS:   ./bin/kproxy-macos-x64 version"
echo "  Windows: ./bin/kproxy-windows-x64.exe version"
echo ""
echo "Ready for GitHub release!"
