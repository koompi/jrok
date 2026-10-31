# Jrok and KConsole Stateless PaaS Review

**Scope:** Read-only review of Jrok's edge, proxy, and certificate paths; KConsole's deploy-worker scheduling and failover; and the worker-to-Jrok tunnel integration. No source files were changed and no tests were run for this review.

## Assessment

The code has real building blocks for stateless app deployment, but it does not yet guarantee high availability across three data centers. KConsole can deploy replicas, perform health-checked rollouts, and reschedule stateless instances after a worker failure. Jrok can accept agent connections, proxy HTTP/WebSocket traffic, and route requests across Jrok servers.

The main gap is failure-domain awareness: the scheduler does not ensure replicas land in different data centers, and the edge and Jrok paths do not yet form a verified, health-aware multi-DC serving design. A worker failure is not the same as a data-center failure.

## What the code implements

### Deploy and worker placement

KConsole's backend selects online deploy workers using resource metrics, priority, image locality, accepted service types, and an anti-affinity penalty for placing replicas of the same service together. That penalty encourages spread, but it is not a guarantee. The selector does not use `region` or `datacenter` when choosing a worker. See `backend/src/utils/queue.ts` and `backend/src/services/service/service.deploy.ts`.

The backend worker model has region and data-center fields, but the worker heartbeat updates host, IP, type, status, metrics, and version—not those location fields. So location metadata exists in the schema, but this heartbeat path does not populate it. See `backend/src/models/Worker.ts` and `backend/src/controllers/internal.controller.ts`.

For stateless services, the worker health service marks silent workers offline and attempts to redeploy their instances elsewhere. It skips sticky services such as databases, VPSs, and templates. Recovery depends on another eligible worker being online and having capacity. See `backend/src/services/worker-health.service.ts`.

### Rollouts and replicas

For Git and image services, the deploy worker starts a replacement container, checks liveness and optional readiness, then switches the tunnel and cleans up the old container. That is useful for deployment rollouts. See `worker/deploy/src/services/ZeroDowntimeDeployer.ts`.

Each worker starts a Jrok agent in group mode for its app instance. Jrok can load-balance among group members connected to the same Jrok server. See `worker/deploy/src/services/JrokService.ts`.

These mechanisms support replicas and recovery, but they do not establish that replicas are in separate data centers or that a site failure will be routed away quickly.

### Jrok edge and cross-server routing

The Ansible Nginx config terminates TLS and proxies HTTP/WebSocket traffic to a consistent-hash upstream. The upstream includes the configured Jrok servers, but the current inventory has only one active server. This is not, by itself, a health-checked global entry across data centers. See `jrok/ansible/roles/nginx/tasks/main.yml` and `jrok/ansible/inventory.ini`.

Jrok also has cross-server routing: it checks which server owns an agent and forwards a request there. That provides a useful routing mechanism, but the internal forwarding URLs use `http://` and `ws://`. For inter-data-center traffic, use a private network plus authenticated encryption, such as mTLS. See `jrok/src/services/crossServerService.ts`.

Worker agents use the same configured `JROK_SERVER` hostname. Nginx hashes on the request host. The code does not demonstrate that agent connections will distribute usefully among Jrok servers or that ingress in every data center can reliably reach the node holding the agent. See `worker/deploy/src/services/JrokService.ts` and `jrok/ansible/roles/nginx/tasks/main.yml`.

### Customer TLS and certificate sync

The domain flow verifies ownership, issues an individual customer-hostname certificate with HTTP-01 when no DNS token is supplied, and uploads certificate material to MongoDB. Other Jrok servers reconcile certificates from MongoDB on startup and every five minutes, then test and reload Nginx. See `jrok/src/services/domainService.ts`, `jrok/src/services/certificateSyncService.ts`, and `jrok/src/index.ts`.

That gives a foundation for distributing certificates, but HTTP-01 issuance currently prepares the challenge config and webroot on the Jrok server handling issuance. If the customer's hostname can send the validation request to another data center, that site may not have the challenge. The challenge path needs to be shared across edges or routed to the issuer. See `jrok/src/services/domainService.ts`.

Certificate sync stores private keys as base64 in MongoDB. The sync endpoints require a server key or super-admin access, which is better than ordinary customer access, but base64 is not encryption. See `jrok/src/services/certificateSyncService.ts` and `jrok/src/index.ts`.

The leader-election code is not currently enforcing a single certificate issuer. The Ansible Certbot timer is enabled on each configured server, so base wildcard certificates may be renewed independently at multiple sites. The deploy hook uploads renewed material, but logs a failed upload rather than making renewal fail or confirming deployment to every edge. See `jrok/src/services/certificateSyncService.ts` and `jrok/ansible/roles/certbot/tasks/main.yml`.

## Recommendations

1. **Keep Nginx for the first multi-DC version.** Pingora or a Rust rewrite would not address the placement, health, challenge-routing, or agent-ownership gaps identified here.
2. **Add location-aware placement.** Populate worker region/data-center identity, prefer replicas in distinct data centers, and make the policy explicit about whether it may fall back to co-locating replicas.
3. **Define a health-aware public HTTP entry across data centers.** It must support WebSockets and stop sending traffic to an unhealthy site. Keep Nginx as the per-site edge.
4. **Make Jrok agent ownership and routing explicit.** Verify that agent connections distribute as intended, and that every healthy edge can route requests to the owning Jrok node over a private, encrypted, authenticated network.
5. **Make customer HTTP-01 challenges reachable at all advertised sites.** A shared challenge store or explicit challenge routing can solve this without asking customers for DNS credentials.
6. **Make certificate issuance single-owner and deployment verifiable.** Renew once, distribute to all eligible edges, and report success only after the edges confirm installation and Nginx reload.
7. **Protect certificate private keys beyond base64 encoding.** Encrypt them before database storage or use a secrets service with narrowly controlled access.

## Conclusion

A Cambodia-focused stateless PaaS is achievable with this architecture, but today's code should be described as **multi-worker with recovery mechanisms**, not as **guaranteed multi-data-center high availability**. The highest-priority work is location-aware replica placement and a verified edge-to-agent routing/failover path.
