# Deployment Guide - jrok

Complete guide for deploying the jrok application across single-node and multi-node environments.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Single-Node Deployment (Local/Docker)](#single-node-deployment-localdocker)
3. [Multi-Node Deployment (DigitalOcean + Ansible)](#multi-node-deployment-digitalocean--ansible)
4. [Automated Deployment Script](#automated-deployment-script)
5. [Verification & Testing](#verification--testing)
6. [Troubleshooting](#troubleshooting)
7. [Cleanup](#cleanup)

---

## Prerequisites

### All Deployments
- Bun.js runtime (for local development)
- Git
- A domain name managed by Cloudflare
- Cloudflare API token (for DNS challenges)
- MongoDB Atlas free account (M0 tier)

### Multi-Node Deployment Only
- Terraform/OpenTofu
- Ansible 2.9+
- DigitalOcean account with API token
- SSH key pair for VPS access

### Optional But Recommended
- Docker & Docker Compose (for local testing)
- jq (JSON processor for debugging)
- curl (for API testing)

---

## Single-Node Deployment (Local/Docker)

This approach runs everything on a single machine using Docker Compose.

### Step 1: Configure Environment

```bash
cd /path/to/jrok

# Create .env file with your configuration
cat > .env <<EOF
NODE_ENV=production
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/jrok
CERT_SYNC_API_KEY=your-secure-api-key
SERVER_ID=local-server
LOG_LEVEL=info
EOF
```

**Important**: Keep the CERT_SYNC_API_KEY secure and use a strong random value.

### Step 2: Set Up Certificates

For local testing without real certificates:

```bash
# Create certificate directory
mkdir -p ./certs/letsencrypt/live/example.com

# Generate self-signed certificates for testing
openssl req -x509 -newkey rsa:4096 -keyout ./certs/letsencrypt/live/example.com/privkey.pem \
  -out ./certs/letsencrypt/live/example.com/fullchain.pem -days 365 -nodes \
  -subj "/CN=example.com"

# Create chain.pem
cp ./certs/letsencrypt/live/example.com/fullchain.pem ./certs/letsencrypt/live/example.com/chain.pem
```

### Step 3: Start Services

```bash
# Build images
docker-compose build

# Start all services
docker-compose up -d

# Verify services are running
docker-compose ps

# Check application health
curl http://localhost:3000/health
```

### Step 4: Verify Deployment

```bash
# View application logs
docker-compose logs -f jrok

# Check nginx configuration
docker-compose exec nginx nginx -t

# Test HTTP redirect
curl -v http://localhost/

# Test HTTPS (with self-signed cert)
curl -k -v https://localhost/
```

### Step 5: Stop Services

```bash
# Stop all services (keeps volumes)
docker-compose stop

# Stop and remove containers + volumes
docker-compose down -v
```

---

## Multi-Node Deployment (DigitalOcean + Ansible)

Deploy across multiple DigitalOcean VPS servers with automatic certificate management.

### Step 1: Create DigitalOcean Droplets with Terraform

```bash
cd /path/to/jrok

# Initialize Terraform
tofu init

# Create terraform variables file
cat > terraform.tfvars <<EOF
do_token = "your-digitalocean-api-token"
vps_count = 3
regions = ["sgp1", "nyc1", "lon1"]
EOF

# Plan and apply
tofu plan
tofu apply
```

**Output**: Write down the VPS IP addresses for each droplet.

### Step 2: Configure Ansible Inventory

Update `ansible/inventory.ini` with your VPS details:

```ini
[JROK_SERVERs]
vps-sgp1 ansible_host=165.227.1.1 ansible_user=ubuntu ansible_ssh_private_key_file=~/.ssh/id_rsa
vps-nyc1 ansible_host=165.227.1.2 ansible_user=ubuntu ansible_ssh_private_key_file=~/.ssh/id_rsa
vps-lon1 ansible_host=165.227.1.3 ansible_user=ubuntu ansible_ssh_private_key_file=~/.ssh/id_rsa

[JROK_SERVERs:vars]
domain_name=example.com
certbot_email=admin@example.com
cloudflare_token=REPLACE_WITH_TOKEN
cloudflare_email=admin@example.com
mongodb_uri=mongodb+srv://user:password@cluster.mongodb.net/jrok
cert_sync_api_key=REPLACE_WITH_SECURE_API_KEY
repo_url=https://github.com/koompi/jrok.git
repo_branch=main
app_dir=/home/ubuntu/jrok
```

### Step 3: Test Ansible Connectivity

```bash
# Test SSH connectivity to all servers
ansible all -i ansible/inventory.ini -m ping

# Gather facts about servers
ansible all -i ansible/inventory.ini -m setup -a "filter=ansible_os_family"
```

### Step 4: Run Ansible Playbook

```bash
# Syntax check first
ansible-playbook ansible/playbook.yml -i ansible/inventory.ini --syntax-check

# Run full deployment (dry-run first is recommended)
ansible-playbook ansible/playbook.yml -i ansible/inventory.ini --check

# Apply changes
ansible-playbook ansible/playbook.yml -i ansible/inventory.ini -v
```

**Execution Time**: ~5-10 minutes per server

**What Gets Configured**:
- ✅ Docker and docker-compose installation
- ✅ Certbot with Cloudflare DNS plugin
- ✅ SSL/TLS wildcard certificate issuance
- ✅ Nginx reverse proxy with SSL termination
- ✅ Application deployment with docker-compose
- ✅ UFW firewall with port 22, 80, 443 open
- ✅ Certificate sync to MongoDB via renewal hooks

### Step 5: Verify Multi-Node Deployment

```bash
# Check Docker status on all servers
ansible all -i ansible/inventory.ini -m shell -a "docker-compose ps" --become

# Verify certificates issued
ansible all -i ansible/inventory.ini -m shell -a "sudo certbot certificates"

# Check nginx status
ansible all -i ansible/inventory.ini -m systemd -a "name=nginx state=started" --become

# View certbot renewal logs
ansible all -i ansible/inventory.ini -m shell -a "tail -20 /var/log/certbot-sync.log" --become
```

### Step 6: Configure DNS

Add DNS records in Cloudflare for your domain:

```
example.com          A       165.227.1.1  (load balancer or primary VPS)
*.example.com        CNAME   example.com
```

For true multi-node load balancing, use a load balancer like:
- Cloudflare Load Balancing
- DigitalOcean Load Balancer
- HAProxy on a separate VPS

---

## Automated Deployment Script

For a fully automated experience, use the provided deployment script:

```bash
# Make scripts executable
chmod +x scripts/deploy.sh scripts/cleanup.sh

# Run deployment
./scripts/deploy.sh
```

**The script will**:
1. Prompt for configuration (domain, email, API tokens)
2. Create/update Terraform configuration
3. Run Terraform to create VPS servers
4. Generate Ansible inventory
5. Run Ansible playbook to configure servers
6. Verify deployment success

**Interactive Prompts**:
```
Domain name: example.com
Admin email: admin@example.com
Cloudflare API token: [hidden]
MongoDB URI: [default provided]
Number of VPS: 1-3
```

---

## Verification & Testing

### HTTP/HTTPS Connectivity

```bash
# Test HTTP redirect to HTTPS
curl -v http://example.com/

# Test HTTPS with valid certificate
curl -v https://example.com/

# Test with specific VPS
curl -v https://example.com --resolve example.com:443:165.227.1.1
```

### Health Checks

```bash
# Application health endpoint
curl https://example.com/health

# Nginx status
curl https://example.com/nginx-status

# Docker container status
docker-compose ps
```

### Certificate Status

```bash
# Check certificate expiration on specific VPS
ssh ubuntu@VPS_IP sudo certbot certificates

# Monitor renewal logs
ssh ubuntu@VPS_IP sudo tail -f /var/log/certbot-sync.log
```

### MongoDB Sync Verification

```bash
# Query MongoDB for stored certificates
mongosh --uri "mongodb+srv://user:password@cluster.mongodb.net/jrok"

db.certificates.find().pretty()
```

Expected output:
```json
{
  "_id": "example.com",
  "domain": "example.com",
  "cert": "-----BEGIN CERTIFICATE-----...",
  "chain": "-----BEGIN CERTIFICATE-----...",
  "privkey": "-----BEGIN PRIVATE KEY-----...",
  "fullchain": "-----BEGIN CERTIFICATE-----...",
  "updated_at": 2024-01-15T10:30:00Z,
  "updated_by": "vps-lon1"
}
```

### Rate Limiting Test

```bash
# General rate limit: 10 requests per second
for i in {1..20}; do curl http://localhost/health & done; wait

# Certificate API rate limit: 5 requests per second
for i in {1..10}; do curl -X POST http://localhost/certificates/upload & done; wait
```

---

## Troubleshooting

### Docker Issues

**Problem**: Docker daemon not running
```bash
# Restart Docker
sudo systemctl restart docker

# Check Docker status
sudo systemctl status docker

# View Docker logs
sudo journalctl -u docker -n 50
```

**Problem**: Containers not starting
```bash
# Check container logs
docker-compose logs jrok
docker-compose logs nginx

# Rebuild images
docker-compose build --no-cache
```

### Certificate Issues

**Problem**: Certificate not issued
```bash
# Check certbot logs
sudo tail -100 /var/log/letsencrypt/letsencrypt.log

# Test DNS challenge manually
nslookup _acme-challenge.example.com
```

**Problem**: Certificate renewal failed
```bash
# Manually trigger renewal (dry-run)
sudo certbot renew --dry-run --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/secrets/cloudflare.ini

# Check renewal hooks
ls -la /etc/letsencrypt/renewal-hooks/post/

# View MongoDB sync script
cat /etc/letsencrypt/renewal-hooks/post/mongodb-sync.sh
```

### Nginx Issues

**Problem**: Nginx not proxying correctly
```bash
# Test nginx configuration
sudo nginx -t

# Check nginx logs
sudo tail -50 /var/log/nginx/error.log

# Verify upstream connectivity
curl http://127.0.0.1:3000/health
```

**Problem**: SSL certificate not found
```bash
# Verify certificate exists
sudo ls -la /etc/letsencrypt/live/example.com/

# Check nginx.conf for correct paths
sudo grep -A 2 "ssl_certificate" /etc/nginx/nginx.conf
```

### Ansible Issues

**Problem**: Host unreachable
```bash
# Test connectivity
ansible all -i ansible/inventory.ini -m ping

# Try with SSH debugging
ansible all -i ansible/inventory.ini -m ping -vvv
```

**Problem**: Permission denied
```bash
# Verify SSH key permissions
chmod 600 ~/.ssh/id_rsa

# Test SSH directly
ssh -i ~/.ssh/id_rsa ubuntu@VPS_IP
```

**Problem**: Task failed
```bash
# Run playbook with more verbosity
ansible-playbook ansible/playbook.yml -i ansible/inventory.ini -vvv

# Run specific task
ansible-playbook ansible/playbook.yml -i ansible/inventory.ini --start-at-task="Task Name"
```

### MongoDB Connection Issues

**Problem**: Cannot connect to MongoDB
```bash
# Verify connection string format
# Format: mongodb+srv://username:password@cluster.mongodb.net/database

# Test connection
mongosh --uri "mongodb+srv://user:password@cluster.mongodb.net/jrok"

# Check firewall rules
# MongoDB Atlas allows IP whitelist - ensure VPS IPs are whitelisted
```

---

## Cleanup

### Remove Local Docker Deployment

```bash
# Stop and remove containers
docker-compose down -v

# Remove built images
docker image rm jrok:latest
```

### Clean Remote VPS Servers

```bash
# Option 1: Using cleanup script
./scripts/cleanup.sh remote

# Option 2: Manual cleanup via Ansible
ansible all -i ansible/inventory.ini -m shell -a "docker-compose down -v" --become
```

### Destroy Terraform Infrastructure

```bash
# List resources that will be destroyed
tofu plan -destroy

# Destroy with confirmation
tofu destroy

# Or auto-approve (use with caution!)
tofu destroy -auto-approve
```

### Complete Cleanup

```bash
# Everything: local + remote + terraform
./scripts/cleanup.sh all
```

---

## Next Steps

After successful deployment:

1. **Monitor**: Set up monitoring for certificates, uptime, and error rates
2. **Backup**: Implement automated backups for MongoDB collections
3. **Scaling**: Add more VPS servers by increasing `vps_count` in Terraform
4. **Custom Domains**: Update DNS records for additional domains
5. **Automation**: Set up CI/CD for automatic application updates

---

## Support

For issues or questions:
1. Check logs: `docker-compose logs` or `sudo journalctl -u jrok`
2. Review documentation: See IMPLEMENTATION_CHECKLIST.md
3. Test endpoints: `curl https://example.com/health`
