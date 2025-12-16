#!/bin/bash

# Certbot SSL Setup Script for Jrok
# This script automates wildcard SSL certificate generation using Cloudflare DNS

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Jrok SSL Setup ===${NC}"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}This script must be run as root${NC}"
   exit 1
fi

# Prompt for configuration
read -p "Enter your domain (e.g., tunnel.example.com): " BASE_DOMAIN
read -p "Enter your email for Let's Encrypt notifications: " EMAIL
read -p "Enter your Cloudflare API Token: " CF_TOKEN

if [ -z "$BASE_DOMAIN" ] || [ -z "$EMAIL" ] || [ -z "$CF_TOKEN" ]; then
    echo -e "${RED}Error: All fields are required${NC}"
    exit 1
fi

echo -e "${YELLOW}Installing Certbot and Cloudflare plugin...${NC}"

# Update package manager
apt update
apt install -y certbot python3-certbot-dns-cloudflare

# Create secrets directory
mkdir -p /etc/letsencrypt/secrets/
touch /etc/letsencrypt/secrets/cloudflare.ini

# Write Cloudflare credentials
cat > /etc/letsencrypt/secrets/cloudflare.ini << EOF
# Cloudflare API token used by Certbot
dns_cloudflare_api_token = $CF_TOKEN
EOF

# Secure the file
chmod 600 /etc/letsencrypt/secrets/cloudflare.ini

echo -e "${YELLOW}Obtaining wildcard certificate...${NC}"

# Request wildcard certificate
certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/secrets/cloudflare.ini \
  --email "$EMAIL" \
  --agree-tos \
  --non-interactive \
  --no-eff-email \
  -d "$BASE_DOMAIN" \
  -d "*.$BASE_DOMAIN"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Certificate obtained successfully!${NC}"
    echo -e "${GREEN}Certificate path: /etc/letsencrypt/live/$BASE_DOMAIN/${NC}"
    echo ""
    echo -e "${YELLOW}Next steps:${NC}"
    echo "1. Update your .env file with BASE_DOMAIN=$BASE_DOMAIN"
    echo "2. Update nginx configuration (see setup-nginx.sh)"
    echo "3. Reload nginx: sudo systemctl reload nginx"
    echo ""
    echo -e "${YELLOW}Auto-renewal:${NC}"
    echo "Certbot will automatically renew your certificate."
    echo "Test renewal with: sudo certbot renew --dry-run"
else
    echo -e "${RED}Failed to obtain certificate${NC}"
    exit 1
fi
