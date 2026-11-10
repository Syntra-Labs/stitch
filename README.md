# stitch

> **Routing-Layer Persistence Fabric — “The Internet Is a Notebook”**  
> An experimental overlay treating Internet control planes (DNS, Anycast, BGP, WebRTC) as a distributed memory hierarchy with survival-entropy refresh scheduling.

**Live Browser Stitch (Zero Setup):** [https://syntra-labs.github.io/stitch/](https://syntra-labs.github.io/stitch/)

[![Organization: Syntra-Labs](https://img.shields.io/badge/organization-Syntra--Labs-blue.svg)](https://github.com/Syntra-Labs)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

---

## 1. Thesis & Synthesis

**`stitch`** explores a **routing-layer persistence fabric**: using existing Internet control planes (BGP, IPv6 addressing, DNS, anycast, and browser-native peer discovery) as a distributed **memory hierarchy** that keeps pointers, identities, and live peer connections stitched across the Internet without traditional application hosting—using **survival and entropy estimates** to refresh routes and records before they decay into staleness.

Routes are not a hard drive; they are **liveness beacons and pointer stitches**:
- **DNS names & records** are labels on the notebook (cold/warm pointers).
- **BGP & anycast** indicate which copies of the notebook are reachable right now (route availability).
- **WebRTC / WebTransport** hold the active session streams between peers (hot state).
- **Caches, endpoints, and signed manifests** hold the actual page payload at the edges.

---

## 2. Engineering Constraints & Reframing

Before testing, several physical and protocol constraints bound the architecture:

| Original Impulse | Physical / Protocol Constraint | Reframed Experiment in `stitch` |
| :--- | :--- | :--- |
| **BGP routes identity at L7** | BGP is an L3 control plane advertising IP prefixes/reachability, not L7 identity. | **BGP carries reachability/liveness**; L7 identity lives in DNS, TLS, and signed SRV/HTTPS/TXT records. |
| **IPv6 space as bulk storage** | A `/64` is vast, but global BGP table scale (~1M IPv4 / ~200k IPv6 prefixes) is the bottleneck, not address count. | Routing-table modulation is a low-bandwidth, high-churn side channel—used strictly for **availability/metadata**, never bulk payload. |
| **DNS roots track routes** | Root (`.`) and TLD servers serve authoritative referrals via TTLs and anycast; they do not track routes. | DNS roots/TLDs act as **stable cold pointers**. Time comes from NTP/PTP; freshness comes from **TTL & survival models**. |
| **NAT everywhere** | Carrier/edge NAT breaks inbound global addressability per client. | Use **WebRTC DataChannels (STUN/direct/TURN)** for browser edges and an authorized overlay (**DN42 / ULA**) for BGP experiments. |
| **Zero hosting** | You cannot store petabytes in thin air without endpoints or authoritative servers. | Avoid traditional app servers by combining **authoritative DNS + anycast + edge caches + browser peers**. |
| **Quadratic residuals in routes** | Encoding raw payload residuals into BGP announcements causes route flapping and dampening. | Reinterpreted as **signed/erasure-coded pointer records with health & residual metadata**. |

---

## 3. The Four-Layer Memory Hierarchy

| Layer | Tier | What Persists | Mechanism | Refresh Signal |
| :--- | :--- | :--- | :--- | :--- |
| **L0 — Hot** | Real-time | Active sessions, data streams | WebRTC DataChannel / QUIC / WebTransport | Heartbeats, ICE state, short timeouts |
| **L1 — Warm** | Discovery | Service endpoints, object IDs | DNS `SRV` / `HTTPS` / `TXT`, DHT, anycast | DNS TTL, active health checks |
| **L2 — Route** | Availability | Prefix / anycast reachability | BGP announcements, keepalives (DN42 / testbed) | Hold timer, BGP update inter-arrival entropy |
| **L3 — Cold** | Pointers | Names, signed manifests, identities | Authoritative DNS, cryptographic signatures | Long TTLs, key rotation / change events |

---

## 4. Entropy-Driven Survival Refresh

Instead of blind fixed-cron polling, `stitch` models each route or pointer record as a continuous-time **survival process**.

### 4.1 Survival Probability & Refresh Horizon

Given observed inter-update or failure intervals $T_1, T_2, \dots, T_n$, assuming an exponential/Poisson failure process with rate $\hat{\lambda} = \left(\frac{1}{n}\sum_{i=1}^n T_i\right)^{-1}$:

$$P(\text{alive at } t) = e^{-\hat{\lambda} t}$$

Given a maximum acceptable staleness probability $\epsilon \in (0, 1)$ and record `TTL`, the next refresh is scheduled at:

$$t_{\text{refresh}} = \min\left(\frac{\text{TTL}}{2},\; \frac{-\ln(1 - \epsilon)}{\hat{\lambda}}\right)$$

*(Or equivalently using survival threshold $\tau = 1 - \epsilon$, refreshing when $P(\text{alive at } t) \le \tau$, i.e., $t = -\ln(\tau)/\hat{\lambda}$.)*

### 4.2 Binary Staleness Entropy

The uncertainty of whether a pointer/stitch is currently alive vs. dead at age $t$ is given by the binary Shannon entropy (in bits or nats):

$$H(p) = -p \log_2 p - (1 - p) \log_2 (1 - p), \quad p = e^{-\hat{\lambda} t}$$

As $p$ decays from $1 \to 0.5$, uncertainty $H(p) \to 1\text{ bit}$. The scheduler triggers a proactive re-announcement / DNS re-resolution when $H(p)$ crosses a configured hysteresis threshold $H_{\text{thresh}}$ (with randomized jitter to prevent synchronized flapping).

### 4.3 Multi-Route Set Entropy

For $k$ candidate next-hops or endpoints with age-weighted liveness weights $p_i$ ($\sum_i p_i = 1$):

$$H_{\text{routes}} = -\sum_{i=1}^{k} p_i \log_2 p_i$$

To distinguish **healthy multipath diversity** from **stale route uncertainty**, each candidate weight is discounted by its survival factor $e^{-\hat{\lambda}_i t_i}$.

---

## 5. Two-Peer Browser Topology

```
  +----------------------+          DNS SRV / TXT           +----------------------+
  |    Authoritative     | <------------------------------> |   Entropy Survival   |
  |  DNS (_stitch._udp)  |     Cold/Warm Pointer (TTL)      |      Scheduler       |
  +----------+-----------+                                  +----------+-----------+
             |                                                         ^
             | 1. Resolve Pointer                                      | 4. Refresh before H(p)
             v                                                         |    crosses threshold
  +----------------------+        2. WebRTC DataChannel     +----------+-----------+
  |   Peer A (Browser)   | <==============================> |   Peer B (Browser)   |
  |   Static Runtime     |        3. 5s Liveness Ping       |   or Edge Node       |
  +----------------------+                                  +----------------------+
```

### Viable Browser Transport Stacks
1. **`like-webrtc`** *(Fastest to a working stitch)*: Peer-to-peer WebRTC with built-in signaling, STUN/TURN, and cryptographic keypair addressing (`RTC.keyPair()`).
2. **`webconnect`** *(Zero signaling server)*: Uses existing public relays (BitTorrent trackers, MQTT, Nostr) so static pages discover peers with zero backend.
3. **`js-libp2p`** *(Fabric-native)*: WebRTC DataChannels, `multiaddr` pointers, Noise encryption, and DHT/DNSLink discovery.

### Legitimate BGP Overlay Playbooks
- **Playbook A — DN42 Overlay**: Peer two nodes across different networks over WireGuard tunnels using **BIRD** or **FRR**, announcing an authorized private DN42 IPv6 prefix and feeding BGP update inter-arrival times into the survival clock.
- **Playbook B — TANGLED Anycast Testbed**: Measure real-world anycast pointer survival and convergence across distributed research nodes.

---

## 6. Phased Implementation Roadmap

### Phase 0 — Preparation
- [ ] **Choose primary peer transport stack** (`like-webrtc` for immediate stitch, `webconnect` for serverless signaling, or `js-libp2p` for multiaddr fabric).
- [ ] **Provision two distinct network locations** (e.g., home ISP vs. mobile hotspot or two cloud regions—never same LAN).
- [ ] **Secure authoritative DNS domain** capable of publishing `_stitch._udp.<domain>` SRV/TXT records with 30–60s TTLs.
- [ ] **Decide route-layer scope** (DN42 WireGuard + FRR/BIRD setup, or defer Phase 4 until Phases 1–3 are validated).

### Phase 1 — The Two-Peer Stitch (Browser-to-Browser)
- [x] **Build static browser runtime (`index.html`, `src/peer.js`)** with connection state telemetry and heartbeat counter.
- [ ] **Deploy Peer A & Peer B across separate networks** and establish a live WebRTC DataChannel (`stitch`).
- [x] **Implement 5-second liveness heartbeat** recording round-trip latency and inter-arrival timestamps.
- [x] **Instrument ICE/transport failure surface** (STUN vs. TURN fallback, disconnection timestamps).

### Phase 2 — The Pointer Survival Layer (DNS)
- [ ] **Publish low-TTL SRV/TXT record** (`_stitch._udp.example.net`, TTL 30–60s) pointing to Peer B's rendezvous handle.
- [x] **Implement browser-side DoH pointer resolver (`src/pointer.js`)** logging resolution latency, TTL, and inferred cache expiry.
- [ ] **Create automated pointer refresh hook** via DNS provider API.
- [ ] **Measure empirical pointer staleness** when Peer B rotates keys or drops offline.

### Phase 3 — Entropy-Driven Refresh (The Survival Loop)
- [x] **Implement Poisson survival estimator & Shannon entropy calculator (`src/survival.js`)**.
- [x] **Build hysteresis + jitter refresh scheduler** comparing Fixed-TTL vs. Entropy-Driven scheduling.
- [ ] **Run live A/B comparison** measuring staleness events vs. control-plane refresh overhead.
- [ ] **Tune $\epsilon$ and entropy bounds** for optimal stitch stability.

### Phase 4 — Route-Layer Experiment (DN42)
- [ ] **Configure DN42 WireGuard + BIRD/FRR eBGP peering** between two nodes.
- [ ] **Announce/withdraw test prefix** on a controlled schedule and log BGP update inter-arrival times.
- [ ] **Feed BGP update churn into the survival estimator** while respecting the 5-second BGP keepalive stability floor.

### Phase 5 — Integration & First Notebook Page
- [ ] **Unify DNS SRV (cold/warm), WebRTC DataChannel (hot), and BGP (route)** into a single telemetry view.
- [x] **Support signed pointer records** (Ed25519 / WebCrypto signature verification on pointer manifests).
- [ ] **Execute 24-hour cross-Internet soak test** and publish empirical survival curves.

---

## 7. Repository Structure & Quick Start

```
stitch/
├── index.html              # Interactive two-peer stitch & survival simulator UI
├── Makefile                # Build & verification targets
├── package.json            # Node ES module manifest
├── docs/
│   ├── ARCHITECTURE.md     # Deep dive into hierarchy & entropy math
│   └── ROADMAP.md          # Detailed phase checklist & open questions
├── src/
│   ├── survival.js         # Survival process estimator, binary/route entropy & scheduler
│   ├── pointer.js          # DNS-over-HTTPS (DoH) SRV/TXT pointer resolver & verifier
│   └── peer.js             # WebRTC DataChannel two-peer stitch & heartbeat engine
└── tests/
    └── test_survival.js    # Unit & simulation tests for Fixed-TTL vs Entropy refresh
```

### Run the Verification Suite

```bash
make test
```

### Launch the Interactive Browser Stitch UI

Open `index.html` directly in two browser tabs (uses `BroadcastChannel` for local cross-tab signaling alongside native `RTCPeerConnection` DataChannels) or serve locally:

```bash
make serve
```

---

## License

MIT © [Syntra Labs](https://github.com/Syntra-Labs)
