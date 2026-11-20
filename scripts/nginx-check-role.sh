#!/usr/bin/env bash
# The Ansible nginx role on nginx 1.18 (production's version): renders its
# nginx.conf and jrok's current custom-domain vhost, runs them in a throwaway
# container with no network (jrok replaced by a stand-in that echoes the Host
# it got), and checks what the edge cache serves and where /health and
# /certificates/ go. Needs Docker (image nginx:1.18), python3 with jinja2 and
# PyYAML, openssl and bun. Read-only for the tree; nothing leaves the machine.
#   scripts/nginx-check-role.sh [jrok tree, default this one]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WT=${1:-$(dirname "$HERE")}
WORK=$(mktemp -d)
NAME=jrok-nginx-check-$$
ETC=$WORK/etc-nginx
mkdir -p "$ETC/sites-enabled" "$ETC/conf.d" "$WORK/cache" "$WORK/le/live/tunnel.test" "$WORK/le/live/shop.example.test"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

docker run --rm --network none nginx:1.18 cat /etc/nginx/mime.types > "$ETC/mime.types"
python3 "$HERE/nginx-render-role.py" "$WT/ansible/roles/nginx/tasks/main.yml" "$ETC/nginx.conf" >/dev/null
printf 'proxy_set_header X-Jrok-Peer-Key "test";\n' > "$ETC/jrok-peer-key.conf"
printf '# empty\n' > "$ETC/jrok-cache-off.map"
printf '# empty\n' > "$ETC/jrok-blocked-ips.geo"
for d in tunnel.test shop.example.test; do
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$d" \
    -keyout "$WORK/le/live/$d/privkey.pem" -out "$WORK/le/live/$d/fullchain.pem" 2>/dev/null
done

# jrok's own templates, as an edge with this nginx.conf writes them.
( cd "$WT" && NGINX_CONF_PATH="$ETC/nginx.conf" JROK_PEERS=127.0.0.1:3001 bun -e '
  const n = await import("./src/utils/nginxConfig.ts");
  const fs = await import("fs");
  const out = process.argv[1];
  fs.writeFileSync(out + "/00-jrok-upstream.conf", n.generateJrokUpstreamConfig());
  fs.writeFileSync(out + "/shop_example_test.conf", n.generateCustomDomainNginxConfig("shop.example.test", "/etc/letsencrypt/live/shop.example.test"));
' "$ETC/sites-enabled" )
grep -q "jrok-vhost-template: 6" "$ETC/sites-enabled/shop_example_test.conf" || { echo "FAIL: vhost is not v6"; exit 1; }

# The app behind jrok: a file it marks shareable, and an HTML page marked
# s-maxage (as Next.js marks prerendered pages). $msec tells a fresh answer
# from a cached one.
cat > "$ETC/conf.d/app.conf" <<'EOF'
server {
  listen 127.0.0.1:3000;
  listen 127.0.0.1:3010;
  listen 127.0.0.1:3020;
  # Its own add_header, so the stand-in doesn't inherit the edge's (http-level
  # Cache-Control: no-cache would mark every answer as the app's own).
  add_header X-Stand-In 1;
  location / {
    add_header Cache-Control "public, max-age=600";
    return 200 "file $host $msec\n";
  }
  # What the app says nothing about (no Cache-Control): kept only for scripts,
  # styles, fonts and wasm, never HTML (an SPA's fallback), JSON or with a cookie.
  location /static/ {
    default_type application/javascript;
    return 200 "asset $host $msec\n";
  }
  location = /static/data.json {
    default_type application/json;
    return 200 "json $host $msec\n";
  }
  location = /static/fallback.js {
    types { }
    default_type text/html;
    return 200 "<p>fallback $host $msec</p>\n";
  }
  location = /static/cookie.js {
    default_type application/javascript;
    add_header Set-Cookie "s=1";
    return 200 "cookie $host $msec\n";
  }
  location = /page {
    default_type text/html;
    add_header Cache-Control "s-maxage=31536000";
    return 200 "<p>page $host $msec</p>\n";
  }
}
EOF

docker run -d --name "$NAME" --network none \
  -v "$ETC:/etc/nginx" -v "$WORK/le:/etc/letsencrypt:ro" -v "$WORK/cache:/var/cache/nginx/jrok" \
  nginx:1.18 sh -c 'mkdir -p /var/cache/nginx/jrok && exec nginx -g "daemon off;"' >/dev/null
sleep 1
docker exec "$NAME" nginx -t 2>&1 | sed 's/^/  nginx -t: /'

get() { # host path -> "STATUS BODY"
  docker exec "$NAME" sh -c "curl -sk --resolve $1:443:127.0.0.1 -D /tmp/h https://$1$2 > /tmp/b; printf '%s %s' \"\$(grep -i '^x-cache-status' /tmp/h | tr -d '\r' | cut -d' ' -f2)\" \"\$(cat /tmp/b)\""
}
reload() { docker exec "$NAME" nginx -s reload; sleep 1; }
fails=0
check() { # description, got, wanted pattern
  if [[ "$2" =~ $3 ]]; then echo "ok   $1: $2"; else echo "FAIL $1: $2 (wanted $3)"; fails=$((fails+1)); fi
}

for host in open.public.test office.public.test shop.example.test; do
  first=$(get $host /app.js)
  check "$host first request" "$first" '^MISS file'
  check "$host again: from the cache" "$(get $host /app.js)" "^HIT ${first#MISS }$"
  check "$host HTML is never kept" "$(get $host /page)" '^MISS <p>page'
  check "$host HTML again: still not kept" "$(get $host /page)" '^MISS <p>page'
done

# office has an allowlist now, shop.example.test a suspension: jrok writes them.
printf '# jrok\noffice.public.test 1;\noffice.tunnel.test 1;\nshop.example.test 1;\n' > "$ETC/jrok-cache-off.map"
reload
for host in office.public.test shop.example.test; do
  a=$(get $host /app.js); b=$(get $host /app.js)
  check "$host left to jrok: not from the cache" "$a" '^BYPASS file'
  check "$host left to jrok: not stored either" "$b" '^BYPASS file'
  [[ "$a" != "$b" ]] && echo "ok   $host answered fresh each time" || { echo "FAIL $host same answer twice"; fails=$((fails+1)); }
done
check "open.public.test is still cached" "$(get open.public.test /app.js)" '^HIT file'

# An address blocked by hand gets nothing from the cache, on any host.
printf '# jrok\n127.0.0.1 1;\n' > "$ETC/jrok-blocked-ips.geo"
reload
check "blocked address on an open app: not from the cache" "$(get open.public.test /app.js)" '^BYPASS file'
printf '# jrok\n' > "$ETC/jrok-blocked-ips.geo"
reload
check "block lifted: cached again" "$(get open.public.test /app.js)" '^HIT file'

# /health and /certificates/ belong to the app on its own name, and to jrok
# (with the Host it needs) only on a base domain itself.
check "an app's /health reaches the app, with its Host" "$(get myapp.public.test /health)" ' file myapp\.public\.test '
check "an app's /healthz too" "$(get myapp.public.test /healthz)" ' file myapp\.public\.test '
check "the base domain's /health reaches jrok with Host public.test" "$(get public.test /health)" ' file public\.test '
burst() { docker exec "$NAME" sh -c "for i in \$(seq 1 12); do curl -sk -o /dev/null -w '%{http_code} ' --resolve $1:443:127.0.0.1 https://$1/certificates/sync-queue; done"; }
check "12 quick /certificates/ requests to an app: all served" "$(burst myapp.public.test)" '^(200 ){12}$'
check "12 quick /certificates/ requests to the base domain: limited" "$(burst public.test)" '503'

# Unmarked scripts and styles are kept; the browser still asks the edge each time.
printf '# jrok\n' > "$ETC/jrok-cache-off.map"
reload
for host in open.public.test shop.example.test; do
  first=$(get $host /static/app.js?v=1)
  check "$host unmarked script: first" "$first" '^MISS asset'
  check "$host unmarked script: from the cache" "$(get $host /static/app.js?v=1)" "^HIT ${first#MISS }$"
  check "$host unmarked script: browser revalidates" "$(docker exec "$NAME" curl -sk -o /dev/null -D - --resolve $host:443:127.0.0.1 https://$host/static/app.js?v=1 | grep -i '^cache-control' | tr -d '\r')" 'no-cache'
  get $host /static/data.json >/dev/null
  check "$host unmarked JSON: never kept" "$(get $host /static/data.json)" '^MISS json'
  get $host /static/fallback.js >/dev/null
  check "$host HTML under a .js name: never kept" "$(get $host /static/fallback.js)" '^MISS <p>fallback'
  get $host /static/cookie.js >/dev/null
  check "$host script with Set-Cookie: never kept" "$(get $host /static/cookie.js)" '^MISS cookie'
done

# A release: jrok unlinks the app's files (cachePurge.ts); nginx takes the
# missing file for a miss, with nothing worse than that in its error log.
before_shop=$(get shop.example.test /static/app.js?v=1)
before_open=$(get open.public.test /static/app.js?v=1)
docker exec "$NAME" chmod -R a+rwX /var/cache/nginx/jrok
( cd "$WT" && BASE_DOMAIN=public.test JROK_CACHE_DIR="$WORK/cache" bun -e '
  const p = await import("./src/services/cachePurge.ts");
  const r = await p.purgeApps(["open"]);
  console.log(`  purge: ${r.removed} of ${r.scanned} file(s) removed`);
' )
after=$(get open.public.test /static/app.js?v=1)
check "after the release: a miss, the new file" "$after" '^MISS asset'
[[ "$after" != "${before_open/HIT/MISS}" ]] && echo "ok   open.public.test fresh after the purge" || { echo "FAIL open.public.test same answer after the purge"; fails=$((fails+1)); }
check "after the release: cached again" "$(get open.public.test /static/app.js?v=1)" "^HIT ${after#MISS }$"
check "another app's files stay" "$(get shop.example.test /static/app.js?v=1)" "^$before_shop$"
check "no cache errors in nginx's log" "$(docker logs "$NAME" 2>&1 | grep -cE '\[(crit|alert|emerg)\]' || true)" '^0$'

echo
[[ $fails -eq 0 ]] && echo "ALL CHECKS PASSED" || { echo "$fails CHECK(S) FAILED"; exit 1; }
