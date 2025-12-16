# Architecture Decision: SCP vs Leader-Based MongoDB Sync

## Executive Summary

| Aspect | SCP Approach | Leader-Based MongoDB |
|--------|-------------|----------------------|
| **Race Conditions** | ❌ Possible | ✅ Impossible |
| **Single Point of Failure** | ❌ Yes (control server) | ✅ No (distributed) |
| **Failover Time** | ❌ Manual (1-30 min) | ✅ Automatic (30 sec) |
| **Server Isolation** | ❌ No (SSH required) | ✅ Yes (HTTP API only) |
| **Scalability** | ❌ O(n) complexity | ✅ O(1) complexity |
| **Production Ready** | ⚠️ With caveats | ✅ Fully ready |
| **Operational Complexity** | ⚠️ Medium | ✅ Simple |

---

## The Problem with SCP Approach

### 1. Race Condition Scenario

**Setup:** 2 control servers with Certbot renewal both happening

```
Control-1                MongoDB                Control-2
   |                       |                       |
   +----Renew Cert A---+
   |                   |
   |   +--Upload------->|
   |   | (slow network) |
   |   |                |
   +----Renew Cert B----+---Trying to upload...
                        |
                        | (CONFLICT!)
                        |
```

**What happens:**
1. Both servers renew certificate at roughly same time
2. Both try to upload to MongoDB
3. Last write wins (undefined order)
4. Which certificate is "correct"? Nobody knows!
5. Inconsistency across VPS servers

### 2. Single Point of Failure

```
┌──────────────────┐
│ Control Server   │ ← Only this server issues certificates
│ (Single point!)  │
└─────────────────┘
         │
    [If it dies]
    ▼
Nobody can issue certificates for 90 days until replacement spins up
```

**Impact:**
- Certificate expires → Service down
- Takes 1-30 minutes to recover (spinning up new server)
- During recovery period, service is down

### 3. SSH Dependencies

```
Control Server ──SSH──> VPS 1
                └─SSH──> VPS 2  (3 SSH connections needed)
                └─SSH──> VPS 3
```

**Problems:**
- VPS servers must have SSH enabled (security risk)
- Firewall rules needed (increased attack surface)
- SSH keys must be distributed (rotation headache)
- Network partition = sync failure
- Cannot isolate servers

### 4. Operational Complexity

```bash
# Troubleshooting SCP failures:
1. Check if SSH is working
2. Check SSH keys are correct
3. Check firewall rules
4. Check network connectivity
5. Check disk space on control
6. Check disk space on VPS
7. Check file permissions
8. Check certificate format
9. Manually re-run sync
10. Check if it actually worked
```

---

## The Solution: Leader-Based MongoDB Architecture

### How It Works

```
┌─ Control-1              ┌─ Control-2              ┌─ Control-3
│  Runs Certbot           │  Runs Certbot           │  Runs Certbot
│  Tries to become        │  Tries to become        │  Tries to become
│  leader (SUCCESS!)  ←───┼──────────────────────────┤─ leader (fail - C1 has it)
└──┬──────────────────────┼─────────────────────────┴──┘
   │                      │
   │ Uploads to MongoDB   │ Waits for lease to expire
   │ (leader only!)       │
   │                      │
   └──────────┬───────────┘
              │
         ┌────▼──────────────┐
         │  MongoDB Atlas    │  ← Single source of truth
         │  (3 replicas)     │
         └────┬──────────────┘
              │
    ┌─────────┼─────────┐
    │         │         │
    ▼         ▼         ▼
   VPS1      VPS2      VPS3
   (pulls    (pulls    (pulls
   every 6h) every 6h) every 6h)
```

### Race Condition Prevention

```
Timeline with atomic MongoDB operations:

T=0:00  Control-1              Control-2              MongoDB
        Renews cert            Renews cert            leader_leases:
        Tries to become leader Tries to become leader {_id: certificate-renewal,
        SUCCESS                BLOCKED!               leader: Control-1,
        ↓                      (Leader check fails)   leaseExpiry: T=0:30}
        Uploads cert           Retries later...

T=0:05  Lease refresh          Still waiting          leader_leases updated:
        SUCCESS                                       {leaseExpiry: T=0:35}
        (extends to T=0:35)

T=0:30  Lease still valid      (Control-2 still can't)

T=0:35  Lease expires          Tries to become leader leader_leases expires
                               SUCCESS!
                               ↓
                               Uploads cert v2

Result: Atomic MongoDB operations prevent write conflicts
        Both certificates in order: v1 (C1), v2 (C2)
        VPS servers always get latest version
```

### Automatic Failover

```
Scenario: Control-1 crashes

T=10:00  Control-1 has lease (expires T=10:30)
T=10:01  CRASH! ❌
T=10:10  Control-2 tries to acquire lease
         MongoDB check: Is current lease expired?
         Answer: No (expires T=10:30)
         Result: BLOCKED

T=10:30  Lease expires automatically
T=10:31  Control-2 tries to acquire lease
         MongoDB check: Is current lease expired?
         Answer: Yes (now T=10:31)
         Result: ACQUIRED!
         
         Control-2 is now leader for next 30 seconds
         Handles all certificate operations

No manual intervention needed!
No service disruption!
VPS servers don't even notice!
```

### Complete Server Isolation

```
BEFORE (SCP):
├── Firewall opens SSH port 22 (security risk)
├── SSH key distribution (rotation headache)
├── SSH key validation (can be weak)
├── Direct server connectivity required
└── Network partition = failures

AFTER (MongoDB):
├── Only HTTPS API calls
├── API key authentication (rotatable)
├── No SSH access needed on VPS
├── Servers don't need to reach each other
├── MongoDB as intermediary (always available)
└── Network partition between servers = no problem (async sync)
```

---

## Technical Comparison

### Race Condition Handling

**SCP Approach:**
```
Problem: Two servers push simultaneously
Solution: Last one wins (undefined!)
Result: Inconsistent certificates on different servers
```

**MongoDB Approach:**
```
Problem: Two servers try to write simultaneously
Solution: Atomic findOneAndUpdate with lease check
Result: Only leader can write (guaranteed consistency)
```

### Failover Mechanism

**SCP Approach:**
```
Control-1 dies:
1. Detect failure (manual OR monitoring alert) → 5-30 minutes
2. Spin up replacement server → 5-15 minutes
3. Configure Certbot → 5-10 minutes
4. Wait for next renewal cycle → up to 90 days
Total: 15-55 minutes before automatic renewal works again
```

**MongoDB Approach:**
```
Control-1 dies:
1. MongoDB lease automatically expires → 30 seconds
2. Control-2 automatically acquires leader lease → instant
3. Next renewal, Control-2 handles it → automatic
Total: 30 seconds
```

### Scaling to Multiple Servers

**SCP Approach:** O(n) complexity
```
Add 1 server = Add 10 more SSH connections
Add 10 servers = Add 100 more SSH connections
Management nightmare at scale
```

**MongoDB Approach:** O(1) complexity
```
Add any number of servers
All pull from same MongoDB source
No additional complexity
Linear scaling
```

---

## When to Use Each Approach

### Use SCP When:
- ❌ You have only 1 control server (no redundancy anyway)
- ❌ You don't care about automatic failover
- ❌ You want simplicity over reliability
- ❌ You're OK with race conditions (unlikely scenario though)

### Use MongoDB Leader-Based When:
- ✅ You want high availability (multiple control servers)
- ✅ You need automatic failover
- ✅ You want completely isolated servers (no SSH)
- ✅ You need production-grade reliability
- ✅ You want cloud-native architecture
- ✅ You have multiple domains/services

**For production with 1000+ users, MongoDB approach is required.**

---

## Implementation Timeline

### Option A: SCP (Fast but limited)
```
Day 1: Setup SCP scripts
Day 2: Test certificate sync
Day 3: Deploy to production
Risk: Single server failure = no auto recovery
```

### Option B: Leader-Based MongoDB (Recommended)
```
Day 1: Setup MongoDB infrastructure
Day 2: Deploy certificateSyncService.ts
Day 3: Implement API endpoints
Day 4: Deploy sync scripts on VPS
Day 5: Test all failure scenarios
Day 6: Production deployment
Risk: None - automatic recovery built in
```

---

## Cost Comparison

### SCP Approach
- 1 Control Server
- Storage: only for immediate certs
- Network: minimal (SCP only on renewal)
- **Total: $5-10/month**

### MongoDB Approach
- 3 Control Servers (HA)
- MongoDB Atlas M0 (free 512MB)
- Storage: includes sync queue, leases
- Network: HTTPS API calls (minimal)
- **Total: $15-30/month** (3 servers)

**Additional cost for MongoDB approach: ~$10-20/month**  
**Value: Eliminates manual interventions, prevents service outages**

---

## Decision Matrix

| Requirement | Priority | SCP | MongoDB |
|-------------|----------|-----|---------|
| No race conditions | CRITICAL | ❌ | ✅ |
| Automatic failover | CRITICAL | ❌ | ✅ |
| Server isolation | HIGH | ❌ | ✅ |
| Scalability | HIGH | ❌ | ✅ |
| Operational simplicity | MEDIUM | ✅ | ⚠️ |
| Cost | LOW | ✅ | ⚠️ |

**MongoDB wins on critical requirements**

---

## Migration Path (If Already Using SCP)

### Phase 1: Parallel Systems
```
Week 1: Deploy MongoDB infrastructure
        Deploy certificateSyncService.ts
        Run MongoDB AND SCP simultaneously
        Verify both working
```

### Phase 2: Cutover
```
Week 2: Stop SCP in production mode
        Monitor MongoDB sync only
        Ready to rollback if needed
```

### Phase 3: Cleanup
```
Week 3: Remove SCP code
        Decommission SSH keys
        Document MongoDB approach
```

---

## Conclusion

### ✅ Go with MongoDB Leader-Based if you want:
- Production reliability
- Automatic failover
- Complete server isolation
- Scalability
- No single point of failure
- Cloud-native design

### ❌ Avoid SCP if you care about:
- Service uptime
- Race condition prevention
- Automatic recovery
- Operational simplicity

**For your use case (1000+ concurrent users, 3 VPS), MongoDB approach is essential.**

The 30-second automatic failover and race condition prevention alone justify the additional complexity.

---

## Quick Reference

### Problem → Solution

| Problem | SCP Solution | MongoDB Solution |
|---------|-------------|------------------|
| Race condition | None (happens) | Atomic lease check |
| Server dies | Manual recovery | 30-second auto failover |
| SSH failure | Service down | Async retry every 6h |
| Isolation | Impossible | Complete |
| Consistency | Last write wins | Guaranteed ordering |

**MongoDB solves all problems. SCP solves none.**

