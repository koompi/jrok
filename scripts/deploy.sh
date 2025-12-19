#!/bin/bash
#
# Deploy script for jrok
# Usage: ./scripts/deploy.sh
#
# This script automates the complete deployment:
# 1. Prompts for configuration
# 2. Runs Terraform to create VPS servers
# 3. Runs Ansible to configure all servers
# 4. Verifies deployment
#

set -euo pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  jrok Deployment Script         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Function to prompt for input
prompt_input() {
    local prompt="$1"
    local default="${2:-}"
    local input
    
    if [ -n "$default" ]; then
        read -p "$(echo -e ${YELLOW}$prompt${NC}) [$default]: " input
        echo "${input:-$default}"
    else
        while true; do
            read -p "$(echo -e ${YELLOW}$prompt${NC}): " input
            if [ -n "$input" ]; then
                echo "$input"
                break
            fi
        done
    fi
}

# Function to prompt for yes/no
prompt_yesno() {
    local prompt="$1"
    local response
    
    while true; do
        read -p "$(echo -e ${YELLOW}$prompt${NC}) (yes/no): " response
        case "$response" in
            yes|y|YES|Y) return 0 ;;
            no|n|NO|N) return 1 ;;
            *) echo "Please answer yes or no" ;;
        esac
    done
}

echo -e "${GREEN}Step 1: Configuration${NC}"
echo ""

# Check if configuration already exists
if [ -f "$PROJECT_ROOT/.deploy.env" ]; then
    echo -e "${YELLOW}Found existing configuration in .deploy.env${NC}"
    source "$PROJECT_ROOT/.deploy.env"
    
    if prompt_yesno "Use saved configuration?"; then
        echo -e "${GREEN}✓ Using saved configuration${NC}"
        
        # Check for missing KOOMPI config in saved file
        if [ -z "${KOOMPI_CLIENT_ID:-}" ] || [ -z "${KOOMPI_CLIENT_SECRET:-}" ]; then
            echo ""
            echo -e "${YELLOW}Missing KOOMPI OAuth configuration in saved file.${NC}"
            echo -e "${BLUE}--- KOOMPI OAuth Configuration ---${NC}"
            echo "Please go to https://dash.koompi.org to create an account and project."
            
            KOOMPI_CLIENT_ID=$(prompt_input "KOOMPI Client ID")
            KOOMPI_CLIENT_SECRET=$(prompt_input "KOOMPI Client Secret")
            KOOMPI_REDIRECT_URI=$(prompt_input "KOOMPI Redirect URI" "https://$DOMAIN/callback")
            DASHBOARD_URL=$(prompt_input "Dashboard URL" "https://$DOMAIN")
        fi
        
        # Generate new JWT_SECRET if not present
        if [ -z "${JWT_SECRET:-}" ]; then
            JWT_SECRET=$(openssl rand -hex 32)
        fi
    else
        # Get new configuration
        DOMAIN=$(prompt_input "Domain name (e.g., example.com)")
        EMAIL=$(prompt_input "Admin email (for Let's Encrypt)")
        CF_TOKEN=$(prompt_input "Cloudflare API token")
        CF_EMAIL=$(prompt_input "Cloudflare email address")
        MONGODB_URI=$(prompt_input "MongoDB Atlas URI" "mongodb+srv://user:password@cluster.mongodb.net/jrok")
        API_KEY=$(prompt_input "Certificate sync API key" "$(openssl rand -hex 32)")

        # KOOMPI OAuth Configuration
        echo ""
        echo -e "${BLUE}--- KOOMPI OAuth Configuration ---${NC}"
        echo "Please go to https://dash.koompi.org to create an account and project."
        
        KOOMPI_CLIENT_ID=$(prompt_input "KOOMPI Client ID")
        KOOMPI_CLIENT_SECRET=$(prompt_input "KOOMPI Client Secret")
        KOOMPI_REDIRECT_URI=$(prompt_input "KOOMPI Redirect URI" "https://$DOMAIN/auth/callback")
        JWT_SECRET=$(openssl rand -hex 32)
        DASHBOARD_URL=$(prompt_input "Dashboard URL" "https://$DOMAIN")
    fi
else
    # Get deployment configuration
    DOMAIN=$(prompt_input "Domain name (e.g., example.com)")
    EMAIL=$(prompt_input "Admin email (for Let's Encrypt)")
    CF_TOKEN=$(prompt_input "Cloudflare API token")
    CF_EMAIL=$(prompt_input "Cloudflare email address")
    MONGODB_URI=$(prompt_input "MongoDB Atlas URI" "mongodb+srv://user:password@cluster.mongodb.net/jrok")
    API_KEY=$(prompt_input "Certificate sync API key" "$(openssl rand -hex 32)")

    # KOOMPI OAuth Configuration
    echo ""
    echo -e "${BLUE}--- KOOMPI OAuth Configuration ---${NC}"
    echo "Please go to https://dash.koompi.org to create an account and project."
    echo "Create an OAuth application to get your Client ID and Secret."
    echo ""
    
    KOOMPI_CLIENT_ID=$(prompt_input "KOOMPI Client ID")
    KOOMPI_CLIENT_SECRET=$(prompt_input "KOOMPI Client Secret")
    KOOMPI_REDIRECT_URI=$(prompt_input "KOOMPI Redirect URI" "https://$DOMAIN/api/auth/callback")
    JWT_SECRET=$(openssl rand -hex 32)
    DASHBOARD_URL=$(prompt_input "Dashboard URL" "https://$DOMAIN")
fi

# Save configuration
cat > "$PROJECT_ROOT/.deploy.env" <<EOF
DOMAIN=$DOMAIN
EMAIL=$EMAIL
CF_TOKEN=$CF_TOKEN
CF_EMAIL=$CF_EMAIL
MONGODB_URI=$MONGODB_URI
API_KEY=$API_KEY
JWT_SECRET=$JWT_SECRET
KOOMPI_CLIENT_ID=$KOOMPI_CLIENT_ID
KOOMPI_CLIENT_SECRET=$KOOMPI_CLIENT_SECRET
KOOMPI_REDIRECT_URI=$KOOMPI_REDIRECT_URI
DEPLOY_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DASHBOARD_URL=$DASHBOARD_URL
EOF

echo -e "${GREEN}✓ Configuration saved${NC}"
echo ""

# Get infrastructure settings
echo -e "${GREEN}Step 2: Infrastructure Settings${NC}"
echo ""

VPS_COUNT=$(prompt_input "Number of VPS servers to create" "1")

# Validate VPS count
if ! [[ $VPS_COUNT =~ ^[0-9]+$ ]] || [ "$VPS_COUNT" -lt 1 ] || [ "$VPS_COUNT" -gt 10 ]; then
    echo -e "${RED}✗ Invalid VPS count. Must be between 1 and 10.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Will create $VPS_COUNT VPS server(s)${NC}"

# Multi-server TCP port range configuration
if [ "$VPS_COUNT" -gt 1 ]; then
    echo ""
    echo -e "${BLUE}--- Multi-Server TCP Port Configuration ---${NC}"
    echo "Each server needs a unique TCP port range to prevent conflicts."
    echo "Total range available: 10000-20000 (10000 ports)"
    PORTS_PER_SERVER=$((10000 / VPS_COUNT))
    echo "Ports per server: ~$PORTS_PER_SERVER"
    echo ""
fi
echo ""

# Terraform deployment
if prompt_yesno "Run Terraform to create VPS servers?"; then
    echo -e "${GREEN}Step 3: Creating VPS Servers${NC}"
    echo ""
    
    cd "$PROJECT_ROOT"
    
    echo -e "${BLUE}Initializing Terraform...${NC}"
    tofu init
    
    echo -e "${BLUE}Planning Terraform changes...${NC}"
    tofu plan -var="vps_count=$VPS_COUNT" -out=tfplan
    
    echo ""
    if prompt_yesno "Apply Terraform changes?"; then
        echo -e "${BLUE}Applying Terraform changes...${NC}"
        tofu apply tfplan
        
        # Get VPS IPs
        echo -e "${GREEN}✓ VPS servers created${NC}"
        echo ""
        
        # Extract IPs and save to inventory
        echo -e "${BLUE}Extracting VPS information...${NC}"
        REGION_LIST=(sgp1 nyc1 lon1 sfo1 ams1)
        
        # Generate inventory template with port ranges
        echo ""
        echo -e "${BLUE}Generating inventory template with TCP port ranges...${NC}"
        
        PORTS_PER_SERVER=$((10000 / VPS_COUNT))
        PORT_START=10000
        
        cat > "$PROJECT_ROOT/ansible/inventory.ini.new" <<EOF
# Ansible Inventory for jrok VPS deployment (auto-generated)
# Generated: $(date)

[jrok_servers]
EOF
        
        for ((i=0; i<VPS_COUNT; i++)); do
            PORT_MIN=$((PORT_START + (i * PORTS_PER_SERVER)))
            PORT_MAX=$((PORT_MIN + PORTS_PER_SERVER - 1))
            REGION=${REGION_LIST[$((i % ${#REGION_LIST[@]}))]}
            VPS_ID="vps-$(printf '%03d' $((i+1)))"
            
            echo "# Server $((i+1)): Replace YOUR_IP_$((i+1)) with actual IP" >> "$PROJECT_ROOT/ansible/inventory.ini.new"
            echo "$VPS_ID ansible_host=YOUR_IP_$((i+1)) ansible_user=root vps_id=$VPS_ID vps_region=$REGION tcp_port_min=$PORT_MIN tcp_port_max=$PORT_MAX" >> "$PROJECT_ROOT/ansible/inventory.ini.new"
            echo "" >> "$PROJECT_ROOT/ansible/inventory.ini.new"
        done
        
        cat >> "$PROJECT_ROOT/ansible/inventory.ini.new" <<EOF
[jrok_servers:vars]
ansible_ssh_private_key_file=~/.ssh/id_rsa
domain_name=$DOMAIN
certbot_email=$EMAIL
cloudflare_token=$CF_TOKEN
cloudflare_email=$CF_EMAIL
mongodb_uri=$MONGODB_URI
cert_sync_api_key=$API_KEY
api_key=$API_KEY
EOF
        
        echo ""
        echo -e "${YELLOW}Generated inventory template: ansible/inventory.ini.new${NC}"
        echo "Please update the IP addresses and rename to inventory.ini"
        echo ""
        
        # Show Terraform outputs
        echo "Terraform outputs:"
        tofu output vps_servers || true
        
    else
        echo -e "${YELLOW}Terraform apply cancelled${NC}"
        exit 0
    fi
else
    echo -e "${YELLOW}Skipping Terraform. Using existing VPS servers.${NC}"
fi

echo ""

# Ansible deployment
if prompt_yesno "Run Ansible to configure VPS servers?"; then
    echo -e "${GREEN}Step 4: Configuring Servers with Ansible${NC}"
    echo ""
    
    # Check if inventory exists
    if [ ! -f "$PROJECT_ROOT/ansible/inventory.ini" ]; then
        echo -e "${RED}✗ Ansible inventory not found at ansible/inventory.ini${NC}"
        echo "Please create inventory.ini with your VPS IPs"
        exit 1
    fi
    
    # Validate Ansible syntax
    echo -e "${BLUE}Validating Ansible playbook syntax...${NC}"
    ansible-playbook "$PROJECT_ROOT/ansible/playbook.yml" \
        -i "$PROJECT_ROOT/ansible/inventory.ini" \
        --syntax-check
    
    echo -e "${GREEN}✓ Ansible syntax valid${NC}"
    echo ""
    
    # Prompt for which roles to run
    echo "Select which roles to configure:"
    echo "  1) All roles (recommended for fresh servers)"
    echo "  2) Docker only"
    echo "  3) Certbot only"
    echo "  4) Nginx only"
    echo "  5) App only"
    echo ""
    
    ROLE_CHOICE=$(prompt_input "Select option (1-5)" "1")
    
    case "$ROLE_CHOICE" in
        1)
            TAGS="always,basic,docker,certbot,nginx,app,firewall,verify"
            ;;
        2)
            TAGS="always,docker"
            ;;
        3)
            TAGS="always,certbot"
            ;;
        4)
            TAGS="always,nginx"
            ;;
        5)
            TAGS="always,app"
            ;;
        *)
            echo -e "${RED}Invalid option${NC}"
            exit 1
            ;;
    esac
    
    echo ""
    echo -e "${BLUE}Running Ansible playbook...${NC}"
    echo "Domain: $DOMAIN"
    echo "Email: $EMAIL"
    echo "Servers: $VPS_COUNT"
    echo "Tags: $TAGS"
    echo ""
    
    # If running app deployment, sync code first
    if [[ "$TAGS" == *"app"* ]]; then
        echo -e "${BLUE}Syncing application code to ALL VPS servers...${NC}"
        
        # Get ALL VPS IPs from inventory (skip comment lines)
        VPS_IPS=$(grep -v "^#" "$PROJECT_ROOT/ansible/inventory.ini" | grep "ansible_host=" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+')
        
        if [ -z "$VPS_IPS" ]; then
            echo -e "${RED}✗ Could not find any VPS IPs in inventory${NC}"
            exit 1
        fi
        
        # Count servers
        SERVER_COUNT=$(echo "$VPS_IPS" | wc -l | tr -d ' ')
        echo "Found $SERVER_COUNT server(s) in inventory"
        echo ""
        
        # Sync to each server
        SYNC_FAILED=0
        for VPS_IP in $VPS_IPS; do
            echo -e "${BLUE}Syncing to $VPS_IP...${NC}"
            
            rsync -avz --delete \
                --exclude=node_modules \
                --exclude=.git \
                --exclude=.env \
                --exclude=terraform.tfstate \
                --exclude=terraform.tfstate.backup \
                --exclude=.terraform \
                --exclude=cli/node_modules \
                --exclude=dashboard/node_modules \
                "$PROJECT_ROOT/" "root@$VPS_IP:/root/jrok-staging/"
            
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓ Code synced to $VPS_IP${NC}"
            else
                echo -e "${RED}✗ Failed to sync code to $VPS_IP${NC}"
                SYNC_FAILED=1
            fi
            echo ""
        done
        
        if [ $SYNC_FAILED -eq 1 ]; then
            echo -e "${RED}✗ Some syncs failed. Check connectivity.${NC}"
            if ! prompt_yesno "Continue anyway?"; then
                exit 1
            fi
        fi
        
        echo -e "${GREEN}✓ Code synced to all servers${NC}"
        echo ""
    fi
    
    # Run Ansible playbook
    ansible-playbook "$PROJECT_ROOT/ansible/playbook.yml" \
        -i "$PROJECT_ROOT/ansible/inventory.ini" \
        --tags="$TAGS" \
        -e "domain_name=$DOMAIN" \
        -e "certbot_email=$EMAIL" \
        -e "cloudflare_token=$CF_TOKEN" \
        -e "cloudflare_email=$CF_EMAIL" \
        -e "mongodb_uri=$MONGODB_URI" \
        -e "cert_sync_api_key=$API_KEY" \
        -e "jwt_secret=$JWT_SECRET" \
        -e "koompi_client_id=$KOOMPI_CLIENT_ID" \
        -e "koompi_client_secret=$KOOMPI_CLIENT_SECRET" \
        -e "koompi_redirect_uri=$KOOMPI_REDIRECT_URI" \
        -e "dashboard_url=$DASHBOARD_URL" \
        -v
    
    echo ""
    echo -e "${GREEN}✓ Ansible configuration complete${NC}"
    
else
    echo -e "${YELLOW}Skipping Ansible configuration${NC}"
fi

echo ""
echo -e "${GREEN}Step 5: Deployment Summary${NC}"
echo ""
echo "Configuration saved to: $PROJECT_ROOT/.deploy.env"
echo "Inventory location: $PROJECT_ROOT/ansible/inventory.ini"
echo "Playbook location: $PROJECT_ROOT/ansible/playbook.yml"
echo ""
echo "Next steps:"
echo "  1. Verify all services are running:"
echo "     ansible all -i ansible/inventory.ini -m command -a 'systemctl status jrok'"
echo ""
echo "  2. Check certificate status:"
echo "     ansible all -i ansible/inventory.ini -m command -a 'sudo certbot certificates'"
echo ""
echo "  3. Test HTTPS access:"
echo "     curl -v https://$DOMAIN/health"
echo ""
echo "  4. Check cluster status (multi-server):"
echo "     curl https://$DOMAIN/cluster/stats"
echo ""
echo "  5. View logs on a server:"
echo "     ssh root@VPS_IP 'journalctl -u jrok -f'"
echo ""
echo -e "${BLUE}Multi-Server Configuration:${NC}"
echo "  - Each server has unique VPS_ID and TCP port range"
echo "  - Port ranges are set in ansible/inventory.ini"
echo "  - Nginx uses consistent hashing for session affinity"
echo "  - MongoDB stores distributed state for cross-server routing"
echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Deployment Complete! ✓              ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
