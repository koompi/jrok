#!/usr/bin/env bash
set -e

echo "🔨 Building jrok CLI..."

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Clean previous builds
echo -e "${BLUE}Cleaning previous builds...${NC}"
rm -rf dist/ bin/jrok

# Build JS bundle
echo -e "${BLUE}Building JavaScript bundle...${NC}"
bun build src/index.ts --outdir dist --target node --minify --sourcemap
echo -e "${GREEN}✓ JavaScript bundle created${NC}"

# Make bin directory
mkdir -p bin

# Create executable wrapper
echo -e "${BLUE}Creating executable...${NC}"
cat > bin/jrok << 'EOF'
#!/usr/bin/env node
require('../dist/index.js');
EOF

# Make it executable
chmod +x bin/jrok
echo -e "${GREEN}✓ Executable created${NC}"

# Optional: Create standalone binary (requires bun)
if command -v bun &> /dev/null; then
  echo -e "${BLUE}Creating standalone binary...${NC}"
  bun build src/index.ts --compile --outfile bin/jrok-standalone
  chmod +x bin/jrok-standalone
  echo -e "${GREEN}✓ Standalone binary created${NC}"
fi

echo -e "${GREEN}✨ Build complete!${NC}"
echo ""
echo "Test locally:"
echo "  ./bin/jrok version"
echo "  ./bin/jrok help"
echo ""
echo "Install globally:"
echo "  npm link"
echo "  jrok version"
