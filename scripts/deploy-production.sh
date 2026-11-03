#!/bin/bash
# Deploy jrok to the production edges with Ansible.
#
#   scripts/deploy-production.sh [tags]          default "app"; a first build needs
#                                                 "always,basic,certbot,nginx,geoip,app,firewall"
#   JROK_LIMIT=edge2,edge3 scripts/deploy-production.sh ...    some edges only
#
# Deploys exactly the release branch (origin/v2.6.5, what workers' install.sh
# installs): the code and the playbook, never the working tree. The inventory is ansible/inventory.production.ini
# (not committed). Secrets are read from the first production edge's
# jrok.service, certbot and GeoIP files at run time, so they are kept in one
# place and never printed; JROK_PEER_KEY (and Telegram and JROK_CERT_KEY, when set) come from
# ~/.config/jrok-production/secrets.env. The playbook runs one edge at a time
# and stops if an edge's agents don't come back (P26).
set -euo pipefail
cd "$(dirname "$0")/.."
TAGS=${1:-app}
REF=${JROK_REF:-origin/v2.6.5}
INVENTORY=ansible/inventory.production.ini
ENV_FILE=${JROK_PRODUCTION_ENV:-$HOME/.config/jrok-production/secrets.env}
SOURCE=${JROK_SECRETS_FROM:-152.42.241.139}
[ -f "$INVENTORY" ] || { echo "missing $INVENTORY" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
. "$ENV_FILE"

SSH="ssh -n -o BatchMode=yes"
# Secrets live in /etc/jrok/jrok.env (root only); the rest, and older edges, in the unit.
unit() { $SSH "root@$SOURCE" "v=\$(sed -n 's/^$1=//p' /etc/jrok/jrok.env 2>/dev/null | head -1); [ -n \"\$v\" ] && printf '%s\\n' \"\$v\" || sed -n 's/^Environment=$1=//p' /etc/systemd/system/jrok.service"; }
export MONGODB_URI; MONGODB_URI=$(unit MONGODB_URI)
export CERT_SYNC_API_KEY; CERT_SYNC_API_KEY=$(unit API_KEY)
export JWT_SECRET; JWT_SECRET=$(unit JWT_SECRET)
export KOOMPI_CLIENT_ID; KOOMPI_CLIENT_ID=$(unit KOOMPI_CLIENT_ID)
export KOOMPI_CLIENT_SECRET; KOOMPI_CLIENT_SECRET=$(unit KOOMPI_CLIENT_SECRET)
export KOOMPI_REDIRECT_URI; KOOMPI_REDIRECT_URI=$(unit KOOMPI_REDIRECT_URI)
export DASHBOARD_URL; DASHBOARD_URL=$(unit DASHBOARD_URL)
export CLOUDFLARE_TOKEN; CLOUDFLARE_TOKEN=$($SSH "root@$SOURCE" 'sed -n "s/^dns_cloudflare_api_token *= *//p" /etc/letsencrypt/secrets/cloudflare.ini')
export MAXMIND_ACCOUNT_ID; MAXMIND_ACCOUNT_ID=$($SSH "root@$SOURCE" 'sed -n "s/^AccountID *//p" /etc/GeoIP.conf')
export MAXMIND_LICENSE_KEY; MAXMIND_LICENSE_KEY=$($SSH "root@$SOURCE" 'sed -n "s/^LicenseKey *//p" /etc/GeoIP.conf')
# JROK_CERT_KEY (certificate private keys encrypted in MongoDB) is optional
# here; once the edges have one, the playbook refuses a deploy without it.
export JROK_PEER_KEY TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" JROK_CERT_KEY="${JROK_CERT_KEY:-}"
for v in MONGODB_URI CERT_SYNC_API_KEY JWT_SECRET DASHBOARD_URL CLOUDFLARE_TOKEN JROK_PEER_KEY; do
  [ -n "${!v}" ] || { echo "could not read $v" >&2; exit 1; }
done

# The release branch, as files.
git fetch -q origin
TREE=$(mktemp -d)
trap 'rm -rf "$TREE"' EXIT
git archive "$REF" | tar -x -C "$TREE"
echo "deploying $REF ($(git rev-parse --short "$REF"))"

hosts() { awk '/^edge[0-9]+ /{for(i=1;i<=NF;i++) if($i ~ /^ansible_host=/){sub("ansible_host=","",$i); print $1, $i}}' "$INVENTORY"; }
while read -r name ip; do
  if [ -n "${JROK_LIMIT:-}" ] && [[ ",$JROK_LIMIT," != *",$name,"* ]]; then continue; fi
  rsync -az --delete --exclude node_modules --exclude .git --exclude .env --exclude 'ansible/inventory*.ini' \
    --exclude 'connector/target*' --exclude cli/dist "$TREE/" "root@$ip:/root/jrok-staging/"
  echo "copied to $name ($ip)"
done < <(hosts)

export ANSIBLE_NOCOLOR=1
# JROK_LOG=<file>: the full output as well (e.g. with JROK_ANSIBLE_ARGS="--check --diff"
# to preview), mode 600, every secret value replaced by <redacted>.
LOG=${JROK_LOG:-/dev/null}
[ "$LOG" = /dev/null ] || { (umask 077; : > "$LOG"); }
# The playbook and roles from the same release as the code (the inventory
# isn't committed, so it comes from here).
INVENTORY_PATH="$PWD/$INVENTORY"
cd "$TREE/ansible"
# The playbook's exit status is the script's (a failed edge exits non-zero),
# after the log is redacted.
status=0
uvx --from ansible ansible-playbook -i "$INVENTORY_PATH" playbook.yml --tags "$TAGS" \
  ${JROK_LIMIT:+--limit "$JROK_LIMIT"} ${JROK_ANSIBLE_ARGS:-} | tee -a "$LOG" | \
  { grep -E '^(PLAY RECAP|TASK \[app : (Check application health|Show application status))|fatal|FAILED|ok=|"msg": "✅|agents connected|agents came back' || true; } || status=$?
if [ "$LOG" != /dev/null ]; then
  for v in MONGODB_URI CERT_SYNC_API_KEY JWT_SECRET KOOMPI_CLIENT_SECRET CLOUDFLARE_TOKEN MAXMIND_LICENSE_KEY JROK_PEER_KEY TELEGRAM_BOT_TOKEN JROK_CERT_KEY; do
    if [ -n "${!v}" ]; then SECRET="${!v}" perl -pi -e 's/\Q$ENV{SECRET}\E/<redacted>/g' "$LOG"; fi
  done
fi
exit "$status"
