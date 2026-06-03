# Ansible Deployment Guide

Automate your KProxy node configuration and deployment using Ansible.

KProxy nodes are stateless Bun processes fronted by **Cloudflare** (edge TLS + Load Balancer) and
wired together by an in-memory **gossip mesh**. There are **no `certbot` or `nginx` roles** — those
were removed when TLS moved to Cloudflare and routing moved to gossip. Only two roles remain:

- **`docker`** — installs Docker / container runtime prerequisites
- **`app`** — clones the repo, installs Bun, renders the environment, and runs the `kproxy` service

## Prerequisites

- VPS server(s) provisioned (e.g. via Terraform)
- SSH access to your VPS
- Ansible installed locally
- Required credentials (MongoDB, Cloudflare API token + Zone ID, KOOMPI OAuth, gossip secret)
- A Cloudflare zone in front of the nodes — see [Cloudflare Setup](../configuration/cloudflare.md)

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
    ├── docker/            # Container runtime prerequisites
    │   └── tasks/main.yml
    └── app/               # KProxy application + systemd service
        └── tasks/main.yml
```

## Configuration

### Inventory File

Edit `ansible/inventory.ini`:

```ini
[kproxy_servers]
# Format: name ansible_host=IP ansible_user=root ansible_ssh_private_key_file=~/.ssh/key
vps-sgp1 ansible_host=152.42.226.37 ansible_user=root ansible_ssh_private_key_file=~/.ssh/id_rsa vps_id=node-a vps_host=10.0.0.11
# Add more nodes for a multi-VPS setup (each needs a unique vps_id / vps_host):
# vps-nyc1 ansible_host=10.0.0.2 ansible_user=root vps_id=node-b vps_host=10.0.0.12
# vps-lon1 ansible_host=10.0.0.3 ansible_user=root vps_id=node-c vps_host=10.0.0.13

[kproxy_servers:vars]
# =============================================================================
# DOMAIN
# =============================================================================
base_domain=live.yourdomain.com

# =============================================================================
# CLOUDFLARE FOR SAAS (customer custom domains)
# =============================================================================
# CF_API_TOKEN needs "SSL and Certificates: Edit" on the zone.
cf_api_token=YOUR_CLOUDFLARE_API_TOKEN
cf_zone_id=YOUR_CLOUDFLARE_ZONE_ID
cf_saas_fallback_hostname=live.yourdomain.com

# =============================================================================
# GOSSIP ROUTING MESH (same secret on every node)
# =============================================================================
gossip_secret=YOUR_SHARED_GOSSIP_SECRET
# vps_id / vps_host are set per-host above. Optionally label nodes:
vps_name=kproxy
vps_region=sgp1

# =============================================================================
# MONGODB (cold/durable state)
# =============================================================================
# Get from: MongoDB Atlas → Database → Connect → Connect your application
mongodb_uri=mongodb+srv://user:password@cluster.mongodb.net/kproxy?retryWrites=true&w=majority
mongo_db_name=kproxy

# =============================================================================
# KOOMPI OAUTH (dashboard login)
# =============================================================================
koompi_client_id=YOUR_KOOMPI_CLIENT_ID
koompi_client_secret=YOUR_KOOMPI_CLIENT_SECRET
koompi_redirect_uri=https://live.yourdomain.com/auth/callback

# =============================================================================
# APPLICATION SETTINGS
# =============================================================================
dashboard_url=https://live.yourdomain.com

# Security secret (generate with: openssl rand -base64 64)
jwt_secret=YOUR_JWT_SECRET_64_CHARS

# Repository settings
repo_url=https://github.com/koompi/jrok.git
repo_branch=main
app_dir=/opt/kproxy

# SSH settings
ansible_port=22
ansible_connection=ssh
ansible_timeout=30
```

> No `certbot_email`, no `cloudflare DNS-01` credentials, and no `cert_sync_api_key` — Cloudflare
> issues and renews every public certificate. The only Cloudflare values KProxy needs are the API
> token, Zone ID, and SaaS fallback hostname for **Custom Hostnames**.

### Environment Variables Method

Instead of hardcoding secrets, use environment variables:

```bash
# Export secrets
export CF_API_TOKEN="your-token"
export CF_ZONE_ID="your-zone-id"
export GOSSIP_SECRET="your-shared-secret"
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
# Only container runtime
ansible-playbook -i inventory.ini playbook.yml --tags "docker"

# Only the application
ansible-playbook -i inventory.ini playbook.yml --tags "app"

# Both
ansible-playbook -i inventory.ini playbook.yml --tags "docker,app"
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
- name: Setup kproxy nodes
  hosts: kproxy_servers
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
    - docker  # Container runtime prerequisites
    - app     # KProxy application + systemd service

  post_tasks:
    - name: Setup firewall
      ufw:
        rule: allow
        port: "{{ item }}"
        proto: tcp
      loop: ["22", "443", "3000"]   # plus your TCP tunnel port range

    - name: Enable UFW
      ufw:
        state: enabled
```

> In production, restrict `:443` (and the app port) to the [Cloudflare IP ranges](https://www.cloudflare.com/ips/),
> or run `cloudflared` so the origin needs no inbound port at all.

### App Role

Deploys and runs the KProxy application as the `kproxy` systemd service:

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

- name: Render environment file
  template:
    src: environment.j2          # MONGODB_URI, CF_*, GOSSIP_SECRET, VPS_*, etc.
    dest: /etc/kproxy/environment

- name: Create systemd service
  template:
    src: kproxy.service.j2
    dest: /etc/systemd/system/kproxy.service

- name: Start kproxy service
  systemd:
    name: kproxy
    state: started
    enabled: yes
    daemon_reload: yes
```

## Post-Deployment

### Verify Services

```bash
# SSH into server
ssh root@YOUR_VPS_IP

# Check kproxy service
systemctl status kproxy
journalctl -u kproxy -f

# In multi-node setups, confirm the mesh formed:
journalctl -u kproxy | grep gossip   # look for "gossip: connected to peer <id>"

# Edge cert is live (browser ⇄ Cloudflare)
curl -I https://live.yourdomain.com/health
```

### Manual Commands

```bash
# Restart kproxy
systemctl restart kproxy

# View logs
journalctl -u kproxy --since "1 hour ago"
```

## Troubleshooting

### SSH Connection Failed

```bash
ssh -v root@YOUR_VPS_IP
ssh-add -l
ssh-add ~/.ssh/id_rsa
```

### Service Won't Start

```bash
# Check logs
journalctl -u kproxy -n 100

# Check environment + unit
cat /etc/systemd/system/kproxy.service
cat /etc/kproxy/environment

# Test manually
cd /opt/kproxy
/root/.bun/bin/bun run dist/index.js
```

### Gossip Peers Not Connecting (multi-node)

- Confirm `VPS_HOST:PORT/_gossip` is reachable **node-to-node** (private network / firewall).
- Confirm `GOSSIP_SECRET` is identical on every node (mismatch → 403 on `/_gossip`).
- Confirm each `VPS_ID` is unique.

### Custom Hostname / Certificate Issues

Certificates are issued by Cloudflare, not on the node — check **SSL/TLS → Custom Hostnames**
(and **Edge Certificates** for Universal SSL) in the Cloudflare dashboard. See
[Cloudflare Setup](../configuration/cloudflare.md).

---

## Next Steps

- [Docker Deployment](./docker.md) — container-based alternative
- [Cloudflare Setup](../configuration/cloudflare.md) — edge TLS, Load Balancer, Cloudflare for SaaS
- [Environment Variables](../configuration/environment.md) — all config options
- [Multi-Server Deployment](./multi-server.md) — high availability and scaling
