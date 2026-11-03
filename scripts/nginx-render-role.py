"""Render the Ansible nginx role's nginx.conf for a two-edge test setup.

usage: python3 scripts/nginx-render-role.py <role main.yml> <out nginx.conf>
(called by scripts/nginx-check-role.sh)
"""
import re
import sys

import jinja2
import yaml

role, out = sys.argv[1], sys.argv[2]
tasks = yaml.safe_load(open(role))
task = next(t for t in tasks if t.get("name") == "Create Nginx configuration")
template = task["copy"]["content"]

env = jinja2.Environment(undefined=jinja2.StrictUndefined, keep_trailing_newline=True)
env.filters["bool"] = lambda v: v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
env.filters["regex_escape"] = lambda s: re.sub(r"([.^$*+?()\[\]{}|\\])", r"\\\1", s)

values = {
    "jrok_base_domains": ["public.test", "tunnel.test"],
    "jrok_ssl_cert_name": "tunnel.test",
    "jrok_peer_tls": True,
    "jrok_peer_gateway_port": 3001,
    "jrok_peer_name": "jrok-peer.public.test",
    "jrok_peer_sources": ["10.0.0.2"],
    "forward_host": "edge-a.public.test",
    "groups": {"jrok_servers": ["edge-a", "edge-b"]},
    "inventory_hostname": "edge-a",
    "hostvars": {"edge-a": {"ansible_host": "10.0.0.1"}, "edge-b": {"ansible_host": "10.0.0.2"}},
}
rendered = env.from_string(template).render(**values)
# The official nginx image has the stream module built in.
rendered = rendered.replace("load_module /usr/lib/nginx/modules/ngx_stream_module.so;", "")
open(out, "w").write(rendered)
print(f"wrote {out}")
