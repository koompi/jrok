#!/bin/bash
#
# Cleanup script for jrok
# Usage: ./scripts/cleanup.sh [option]
#
# Options:
#   local    - Cleanup local Docker containers and volumes
#   remote   - Cleanup remote VPS servers via Ansible
#   terraform - Destroy Terraform-created VPS infrastructure
#   all      - Cleanup everything (local + remote + terraform)
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
echo -e "${BLUE}║  jrok Cleanup Script            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Function to prompt for confirmation
confirm() {
    local prompt="$1"
    local response
    
    while true; do
        read -p "$(echo -e ${RED}$prompt${NC}) (yes/no): " response
        case "$response" in
            yes|y|YES|Y) return 0 ;;
            no|n|NO|N) return 1 ;;
            *) echo "Please answer yes or no" ;;
        esac
    done
}

# Cleanup option
CLEANUP_OPTION="${1:-menu}"

if [ "$CLEANUP_OPTION" == "menu" ]; then
    echo "Select cleanup option:"
    echo "  1) Local Docker cleanup (containers, volumes, networks)"
    echo "  2) Remote VPS cleanup (via Ansible)"
    echo "  3) Terraform destroy (VPS infrastructure)"
    echo "  4) Full cleanup (all of the above)"
    echo "  5) Cancel"
    echo ""
    read -p "Select option (1-5): " choice
    
    case "$choice" in
        1) CLEANUP_OPTION="local" ;;
        2) CLEANUP_OPTION="remote" ;;
        3) CLEANUP_OPTION="terraform" ;;
        4) CLEANUP_OPTION="all" ;;
        5) echo -e "${YELLOW}Cancelled${NC}"; exit 0 ;;
        *) echo -e "${RED}Invalid option${NC}"; exit 1 ;;
    esac
fi

# Local Docker cleanup
cleanup_local() {
    echo -e "${GREEN}Local Docker Cleanup${NC}"
    echo ""
    
    if ! command -v docker-compose &> /dev/null; then
        echo -e "${YELLOW}docker-compose not found, skipping local cleanup${NC}"
        return
    fi
    
    cd "$PROJECT_ROOT"
    
    if [ ! -f "docker-compose.yml" ]; then
        echo -e "${YELLOW}docker-compose.yml not found${NC}"
        return
    fi
    
    echo "Stopping docker-compose services..."
    docker-compose down --volumes 2>/dev/null || true
    
    echo "Removing dangling images..."
    docker image prune -f 2>/dev/null || true
    
    echo -e "${GREEN}✓ Local Docker cleanup complete${NC}"
    echo ""
}

# Remote VPS cleanup
cleanup_remote() {
    echo -e "${GREEN}Remote VPS Cleanup${NC}"
    echo ""
    
    if [ ! -f "$PROJECT_ROOT/ansible/inventory.ini" ]; then
        echo -e "${YELLOW}Ansible inventory not found${NC}"
        return
    fi
    
    if ! confirm "⚠️  Remove all Docker containers, volumes, and images from remote servers?"; then
        echo -e "${YELLOW}Skipped remote cleanup${NC}"
        return
    fi
    
    echo -e "${BLUE}Running cleanup playbook on remote servers...${NC}"
    echo ""
    
    # Create temporary cleanup playbook
    TEMP_PLAYBOOK=$(mktemp)
    cat > "$TEMP_PLAYBOOK" <<'PLAYBOOK'
---
- hosts: all
  become: yes
  gather_facts: no
  
  tasks:
    - name: Stop docker-compose services
      shell: |
        cd {{ app_dir }}
        docker-compose down -v 2>/dev/null || true
      ignore_errors: yes
      
    - name: Remove all Docker containers
      shell: |
        docker container prune -f 2>/dev/null || true
      ignore_errors: yes
      
    - name: Remove all Docker images
      shell: |
        docker image prune -a -f 2>/dev/null || true
      ignore_errors: yes
      
    - name: Remove Docker volumes
      shell: |
        docker volume prune -f 2>/dev/null || true
      ignore_errors: yes
      
    - name: Show Docker status after cleanup
      shell: |
        docker ps -a
        docker images
      register: docker_status
      
    - name: Display cleanup results
      debug:
        msg: "{{ docker_status.stdout }}"
PLAYBOOK
    
    ansible-playbook "$TEMP_PLAYBOOK" \
        -i "$PROJECT_ROOT/ansible/inventory.ini" \
        -e "app_dir=/home/ubuntu/jrok"
    
    rm -f "$TEMP_PLAYBOOK"
    
    echo -e "${GREEN}✓ Remote VPS cleanup complete${NC}"
    echo ""
}

# Terraform destroy
cleanup_terraform() {
    echo -e "${GREEN}Terraform Infrastructure Destruction${NC}"
    echo ""
    
    if [ ! -f "$PROJECT_ROOT/jrok.tf" ]; then
        echo -e "${YELLOW}Terraform configuration not found${NC}"
        return
    fi
    
    if [ ! -f "$PROJECT_ROOT/terraform.tfstate" ] && [ ! -f "$PROJECT_ROOT/.terraform.lock.hcl" ]; then
        echo -e "${YELLOW}No Terraform state found (infrastructure may not be deployed)${NC}"
        return
    fi
    
    if ! confirm "⚠️  DANGER: Destroy all Terraform-created VPS servers? This cannot be undone!"; then
        echo -e "${YELLOW}Skipped Terraform destroy${NC}"
        return
    fi
    
    echo -e "${RED}Final confirmation required${NC}"
    read -p "Type 'destroy all' to confirm: " confirmation
    
    if [ "$confirmation" != "destroy all" ]; then
        echo -e "${YELLOW}Terraform destroy cancelled${NC}"
        return
    fi
    
    cd "$PROJECT_ROOT"
    
    echo -e "${BLUE}Destroying Terraform infrastructure...${NC}"
    tofu destroy -auto-approve
    
    echo -e "${GREEN}✓ Terraform destroy complete${NC}"
    echo ""
}

# Main cleanup flow
case "$CLEANUP_OPTION" in
    local)
        cleanup_local
        ;;
    remote)
        cleanup_remote
        ;;
    terraform)
        cleanup_terraform
        ;;
    all)
        echo -e "${RED}⚠️  Full cleanup will:"
        echo "  1. Stop all local Docker containers and remove volumes"
        echo "  2. Clean up all remote VPS servers"
        echo "  3. Destroy all Terraform-created infrastructure"
        echo ""
        if confirm "Continue with full cleanup?"; then
            cleanup_local
            cleanup_remote
            cleanup_terraform
        else
            echo -e "${YELLOW}Full cleanup cancelled${NC}"
            exit 0
        fi
        ;;
    *)
        echo -e "${RED}Unknown option: $CLEANUP_OPTION${NC}"
        echo "Valid options: local, remote, terraform, all"
        exit 1
        ;;
esac

echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Cleanup Complete                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
