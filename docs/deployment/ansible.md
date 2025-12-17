# Ansible Deployment Guide

Automate your Jrok server configuration and deployment using Ansible.

## Prerequisites

- VPS server(s) provisioned (see [Terraform Setup](./terraform.md))
- SSH access to your VPS
- Ansible installed locally
- Required credentials (MongoDB, Cloudflare, KOOMPI OAuth)

## Installation

```bash
# macOS
brew install ansible

# Linux (pip)
pip3 install ansible

# Linux (apt)
sudo apt install ansible

# Verify
ansible --version
```

## Project Structure

```
ansible/
├── inventory.ini           # Server inventory
├── playbook.yml            # Main playbook
└── roles/
    ├── certbot/            # SSL certificate management
    │   └── tasks/main.yml
    ├── nginx/              # Nginx configuration
    │   └── tasks/main.yml
    └── app/                # Application deployment
        └── tasks/main.yml
```

## Configuration

### Inventory File

Edit `ansible/inventory.ini`:

```ini
[jrok_servers]
# Format: name ansible_host=IP ansible_user=root ansible_ssh_private_key_file=~/.ssh/key
vps-sgp1 ansible_host=152.42.226.37 ansible_user=root ansible_ssh_private_key_file=~/.ssh/id_rsa
# Add more servers for multi-VPS setup:
# vps-nyc1 ansible_host=10.0.0.2 ansible_user=root
# vps-lon1 ansible_host=10.0.0.3 ansible_user=root

[jrok_servers:vars]
# =============================================================================
# DOMAIN CONFIGURATION
# =============================================================================
domain_name=tunnel.yourdomain.com
certbot_email=admin@yourdomain.com

# =============================================================================
# CLOUDFLARE (Required for wildcard SSL)
# =============================================================================
# Get from: Cloudflare Dashboard → My Profile → API Tokens
cloudflare_token=YOUR_CLOUDFLARE_API_TOKEN

# =============================================================================
# MONGODB (Required)
# =============================================================================
# Get from: MongoDB Atlas → Database → Connect → Connect your application
mongodb_uri=mongodb+srv://user:password@cluster.mongodb.net/jrok?retryWrites=true&w=majority

# =============================================================================
# KOOMPI OAUTH (Required for dashboard login)
# =============================================================================
# Get from: https://dash.koompi.org → Create Project → OAuth Settings
koompi_client_id=YOUR_KOOMPI_CLIENT_ID
koompi_client_secret=YOUR_KOOMPI_CLIENT_SECRET
koompi_redirect_uri=https://tunnel.yourdomain.com/auth/callback

# =============================================================================
# APPLICATION SETTINGS
# =============================================================================
dashboard_url=https://tunnel.yourdomain.com

# Security secrets (generate with: openssl rand -base64 64)
jwt_secret=YOUR_JWT_SECRET_64_CHARS
cert_sync_api_key=YOUR_CERT_SYNC_KEY

# Repository settings
repo_url=https://github.com/koompi/jrok.git
repo_branch=main
app_dir=/opt/jrok

# SSH settings
ansible_port=22
ansible_connection=ssh
ansible_timeout=30
```

### Environment Variables Method

Instead of hardcoding secrets, use environment variables:

```bash
# Export secrets
export CLOUDFLARE_TOKEN="your-token"
export MONGODB_URI="your-connection-string"
export KOOMPI_CLIENT_ID="your-client-id"
export KOOMPI_CLIENT_SECRET="your-client-secret"

# Run playbook
ansible-playbook -i inventory.ini playbook.yml
```

The playbook uses `lookup('env', 'VAR_NAME')` to read these.

## Running Ansible

### Test Connection

```bash
cd ansible

# Ping all servers
ansible -i inventory.ini all -m ping

# Expected output:
# vps-sgp1 | SUCCESS => {
#     "ping": "pong"
# }
```

### Full Deployment

```bash
# Run complete playbook
ansible-playbook -i inventory.ini playbook.yml
```

### Run Specific Roles

```bash
# Only SSL certificates
ansible-playbook -i inventory.ini playbook.yml --tags "certbot"

# Only Nginx
ansible-playbook -i inventory.ini playbook.yml --tags "nginx"

# Only application
ansible-playbook -i inventory.ini playbook.yml --tags "app"

# SSL + Nginx
ansible-playbook -i inventory.ini playbook.yml --tags "certbot,nginx"
```

### Dry Run (Check Mode)

```bash
ansible-playbook -i inventory.ini playbook.yml --check
```

### Verbose Output

```bash
ansible-playbook -i inventory.ini playbook.yml -v    # Verbose
ansible-playbook -i inventory.ini playbook.yml -vv   # More verbose
ansible-playbook -i inventory.ini playbook.yml -vvv  # Debug
```

## Playbook Overview

### Main Playbook (`playbook.yml`)

```yaml
---
- name: Setup jrok VPS servers
  hosts: jrok_servers
  become: yes

  pre_tasks:
    - name: Update apt cache
      apt:
        update_cache: yes
        cache_valid_time: 3600

    - name: Install basic packages
      apt:
        name: [curl, wget, git, jq, openssl, ufw, python3-pip]
        state: present

  roles:
    - certbot  # SSL certificates
    - nginx    # Web server
    - app      # Jrok application

  post_tasks:
    - name: Setup firewall
      ufw:
        rule: allow
        port: "{{ item }}"
        proto: tcp
      loop: ["22", "80", "443", "3000"]

    - name: Enable UFW
      ufw:
        state: enabled
```

### Certbot Role

Installs Certbot and obtains wildcard SSL certificates:

```yaml
# roles/certbot/tasks/main.yml
- name: Install certbot with cloudflare plugin
  apt:
    name: [certbot, python3-certbot-dns-cloudflare]
    state: present

- name: Create Cloudflare credentials
  copy:
    content: |
      dns_cloudflare_api_token={{ cloudflare_token }}
    dest: /etc/letsencrypt/secrets/cloudflare.ini
    mode: '0600'

- name: Issue wildcard certificate
  shell: |
    certbot certonly \
      --dns-cloudflare \
      --dns-cloudflare-credentials /etc/letsencrypt/secrets/cloudflare.ini \
      --email {{ certbot_email }} \
      --agree-tos \
      --non-interactive \
      -d "{{ domain_name }}" \
      -d "*.{{ domain_name }}"
```

### Nginx Role

Configures Nginx as reverse proxy with SSL:

```yaml
# roles/nginx/tasks/main.yml
- name: Install Nginx
  apt:
    name: nginx
    state: present

- name: Configure Nginx
  template:
    src: nginx.conf.j2
    dest: /etc/nginx/nginx.conf

- name: Reload Nginx
  systemd:
    name: nginx
    state: reloaded
```

### App Role

Deploys and runs the Jrok application:

```yaml
# roles/app/tasks/main.yml
- name: Install Bun runtime
  shell: curl -fsSL https://bun.sh/install | bash

- name: Clone repository
  git:
    repo: "{{ repo_url }}"
    dest: "{{ app_dir }}"
    version: "{{ repo_branch }}"

- name: Install dependencies
  shell: cd {{ app_dir }} && bun install

- name: Create systemd service
  template:
    src: jrok.service.j2
    dest: /etc/systemd/system/jrok.service

- name: Start jrok service
  systemd:
    name: jrok
    state: started
    enabled: yes
```

## Post-Deployment

### Verify Services

```bash
# SSH into server
ssh root@YOUR_VPS_IP

# Check jrok service
systemctl status jrok
journalctl -u jrok -f

# Check nginx
nginx -t
systemctl status nginx

# Check certificates
certbot certificates
```

### Manual Commands

```bash
# Restart jrok
systemctl restart jrok

# Restart nginx
systemctl restart nginx

# Renew certificates (dry run)
certbot renew --dry-run

# View logs
journalctl -u jrok --since "1 hour ago"
```

## Troubleshooting

### SSH Connection Failed

```bash
# Test SSH manually
ssh -v root@YOUR_VPS_IP

# Check SSH key
ssh-add -l

# Add key if missing
ssh-add ~/.ssh/id_rsa
```

### Certificate Issues

```bash
# Check Cloudflare token
cat /etc/letsencrypt/secrets/cloudflare.ini

# Force renewal
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/secrets/cloudflare.ini \
  -d "domain.com" -d "*.domain.com" --force-renewal
```

### Service Won't Start

```bash
# Check logs
journalctl -u jrok -n 100

# Check environment
cat /etc/systemd/system/jrok.service

# Test manually
cd /opt/jrok
/root/.bun/bin/bun run dist/index.js
```

---

## Next Steps

- [Docker Deployment](./docker.md) - Container-based alternative
- [Environment Variables](../configuration/environment.md) - All config options
- [Multi-Server Setup](../advanced/multi-server.md) - High availability
