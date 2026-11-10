# Native Chromium qualification

Run with Node 22+ and Python 3:

```sh
npm ci --ignore-scripts
npx playwright install --with-deps chromium --only-shell
npm run test:browser
```

`@playwright/test` is exactly pinned in the package lock. The browser job in
`.github/workflows/prism.yml` runs once per submitted revision, without retries,
with one worker, a five-minute suite bound and a ten-minute job bound. The test
server binds only loopback. Failures retain an HTML report, screenshots and
traces. `--list` validates discovery without attempting to start a browser.

These are actual Chromium tests, not the Node synthetic fixtures:

- The shipped page initializes its actual module graph and model-derived journey
  controls. Navigation uses real focus and keyboard activation, preserves inputs
  and mesh hash/history, and retains explicit disclosure guards.
- Real origin-local IndexedDB transactions serialize concurrent authority setup.
  A nonextractable Ed25519 private CryptoKey survives reload and signs a pointer
  that the shipped observer verifies. Reload alone does not pin its public key.
- Actual Web Locks serialize two tabs. Terminating the owner releases the lock
  but preserves its unknown publication intent in IndexedDB. This test writes
  no provider record and does not claim provider reconciliation evidence.
- Two actual pages use authenticated BroadcastChannel signaling, native host-only
  ICE/RTCPeerConnection/SCTP and the shipped ChannelFlow. Large fragmented UTF-8
  payloads are digest-compared after delivery, a real storage fragment receives
  its exact custody acknowledgment, and a remote pure-job checkpoint is replayed.
  One remote holder remains partial, not fabricated recovery. A separate three-page
  trial commits two distinct holders, clears the writer RAM and recovers the exact
  object through actual peer fragment requests. These pages are not independent
  physical failure domains. Reconnection rejects
  an old authenticated incarnation. No fake RTC implementation is installed.
- The actual bundled v86 JavaScript, WASM, BIOS and kernel boot through the shipped
  page. A guest shell command produces observed marker and Linux output, which
  is retained and reconciled before explicit stop/destroy administration.

All external HTTP and WebSocket destinations are aborted before provider
communication. The RTC test passes `iceServers: []` and `publicSignaling: false`;
this disables public signaling sockets and POSTs by construction, and no public
STUN/TURN is used.
Native DOM, WebCrypto, IndexedDB, Web Locks, BroadcastChannel and RTC APIs are not
replaced. Provider unavailability is intentional and not counted as successful
provider interoperability. No user credentials, paid operations or third-party
writes are used.

A green run establishes only this Chromium/runner combination and these bounded
scenarios on its exact revision. It does not establish cross-device authority,
NAT traversal, public signaling/relay/DNS availability, provider writes, durable
remote custody, browser compatibility beyond Chromium or complete guest isolation.
Native Prism/Lean gates and vendor redistribution evidence remain independent.
