#!/bin/bash
# Deploy this working tree to the staging edges (docs/plans/staging-runbook.md).
#
#   scripts/staging/deploy-edges.sh [ansible tags]     default tags: app
#
# Copies the repo to each edge's /root/jrok-staging/, then runs the playbook
# with the given tags against ansible/inventory.staging.ini. Secrets come from
# $JROK_STAGING_ENV (default ~/.config/jrok-staging/secrets.env): MONGO_PW,
# CERT_SYNC_API_KEY, JWT_SECRET, JROK_PEER_KEY. The Cloudflare token is read from the
# production jrok server only when the certbot tag is requested.
set -euo pipefail
cd "$(dirname "$0")/../.."

TAGS=${1:-app}
ENV_FILE=${JROK_STAGING_ENV:-$HOME/.config/jrok-staging/secrets.env}
INVENTORY=ansible/inventory.staging.ini
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
[ -f "$INVENTORY" ] || { echo "missing $INVENTORY" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"

TESTBOX_PRIVATE_IP=${TESTBOX_PRIVATE_IP:-10.130.0.15}
export MONGODB_URI="mongodb://jrok:${MONGO_PW}@${TESTBOX_PRIVATE_IP}:27017/?authSource=admin"
export CERT_SYNC_API_KEY JWT_SECRET JROK_PEER_KEY
export KOOMPI_CLIENT_ID=staging KOOMPI_CLIENT_SECRET=staging
export KOOMPI_REDIRECT_URI=https://jrok-staging.koompi.cloud/auth/callback DASHBOARD_URL=https://jrok-staging.koompi.cloud
export CLOUDFLARE_TOKEN=""
if [[ ",$TAGS," == *",certbot,"* ]]; then
  CLOUDFLARE_TOKEN=$(ssh -o BatchMode=yes root@152.42.241.139 'sed -n "s/^dns_cloudflare_api_token *= *//p" /etc/letsencrypt/secrets/cloudflare.ini')
fi
export ANSIBLE_NOCOLOR=1

for ip in $(awk '/^edge[0-9]+ /{for(i=1;i<=NF;i++) if($i ~ /^ansible_host=/){sub("ansible_host=","",$i); print $i}}' "$INVENTORY"); do
  rsync -az --delete --exclude node_modules --exclude .git --exclude .env --exclude 'ansible/inventory*.ini' ./ "root@$ip:/root/jrok-staging/"
  echo "copied to $ip"
done

cd ansible
uvx --from ansible ansible-playbook -i inventory.staging.ini playbook.yml --tags "$TAGS" | \
  grep -E '^(PLAY RECAP|TASK \[app : (Check application health|Show application status))|fatal|FAILED|ok=|"msg": "✅'
