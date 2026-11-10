# Existing guest candidate: browser qualification

This diagnostic branch does not adopt or publish a guest. Its workflow downloads
artifact 13810002248 from afflom/stitch run 42917114652, requires image SHA-256
`313a6b545290a2b47856b49bfcc4c7577469749b315932ae008d39fe70fc7f07`, and substitutes
only the image and `rdinit=/init` command line in the runner's temporary checkout.
It never rebuilds the guest or toolchain and grants no write permissions.
The `actions: read` permission permits this specific existing artifact download.

Only the production VM UI test and candidate peer test run. Existing source,
Prism and unrelated browser qualification are independent evidence. The UI test
uses the actual page, keyboard, VGA, filesystem nonce, shell command, result
reconciliation, stop/destroy, fresh boot and post-dispatch cancellation. Screenshots
retain the ready operator view and stopped/reconciled view for visual review.
The peer test uses two real LinuxVmNode instances with bundled v86 and native
host-only RTC, bidirectional ICMP via NE2000 and consented Ethernet forwarding.
It checks default denial and receiver revocation, serial shell execution and
unchanged filesystem policy constants. No public signaling or STUN/TURN is used.

Local checks are syntax and discovery only. Local browser/socket execution was
not attempted. Only an observed hosted run may establish browser success. A green
run still does not establish cross-device networking, security isolation, all
resource-limit exhaustion cases or source redistribution clearance. Retained
artifacts expire after 14 days; permanent source distribution is a separate gate.

## First hosted diagnostic and correction

Run [42918706370](https://github.com/afflom/stitch/actions/runs/42918706370)
on `5b57e881f98b78b5af9b393816c5710b2c633a58` failed both tests.
The peer harness needed a root document base for production-relative assets.
The actual UI loaded all assets but timed out before readiness. Its screenshot
showed VGA frozen at early kernel output. The exact-image Node diagnostic
confirmed `bochs-drm` disabled the VGA text console and switched to a dummy
console. Adding `nomodeset` alongside `rdinit=/init` restored the VGA shell.
The production LinuxVmNode keyboard/nonce/9p/shell test passed against this exact
candidate and command line in Node (9.06 seconds). This is not browser proof;
the hosted tests must pass independently with that command line.

Peer fixture addresses are deliberately distinct. Existing suffix-derived
addressing can collide or produce NaN for otherwise accepted transport labels;
this test does not claim automatic address uniqueness or allocation.

## Explicit address integration

The final candidate diagnostic includes operator-configured static guest IPv4
addresses and prefixes. No address is inferred from peer labels. Unconfigured
VMs refuse Ethernet grants; the two real guest fixtures explicitly choose
10.42.0.2/24 and 10.42.0.3/24. The existing default-denial, bilateral-grant,
bidirectional ICMP and receiver-revocation checks remain. Unique address
selection belongs to operators; no automatic allocation protocol is claimed.

Run [42920254481](https://github.com/afflom/stitch/actions/runs/42920254481),
revision `723df67cc524b3c96e6358f52449d57628dcd5ca`, passed the complete
production UI VM lifecycle test in 28.8 seconds. Ready and stopped screenshots
were inspected: visible configured address, output, limits and grants are retained.
The peer test passed both boots and serial execution but failed its first
post-grant ping. Both peers recorded one transmitted and one received frame.
A socket-free two-real-VM diagnostic reproduced the failure independently of
RTC: the intentionally denied initial ping exhausted ARP probes, leaving its
neighbor INCOMPLETE/FAILED. Explicit guest `ip neigh flush dev eth0` between
negative and positive test phases yielded first-attempt ping success. The final test does not flush neighbor state. Instead it permits at most three
real one-packet probes with a three-second guest timeout after granting, recording
each exact output and neighbor state. At least one probe must succeed. This
checks natural denied-to-granted recovery without implying immediate delivery.
It also retains bounded frame headers and authenticated routing diagnostics.
No guest, runtime, transport, image, or global timeout was changed to mask the
failure. The next hosted job runs the peer spec only, reusing the passed UI result
on the identical runtime source and immutable image. Hosted peer qualification
remains pending until this bounded natural-recovery test passes.

## Observed successful candidate matrix

- Immutable image SHA-256:
  `313a6b545290a2b47856b49bfcc4c7577469749b315932ae008d39fe70fc7f07`.
- Required host command line:
  `console=tty0 console=ttyS0,115200 rdinit=/init nomodeset`.
- Production UI lifecycle passed on revision
  `723df67cc524b3c96e6358f52449d57628dcd5ca`,
  [run 42920254481, job 130193002437](https://github.com/afflom/stitch/actions/runs/42920254481/job/130193002437),
  in 28.8 seconds. This includes explicit static address, real VGA/keyboard shell,
  nonce-based bidirectional 9p readiness, captured output, reconciliation,
  stop/destroy, fresh boot, post-dispatch cancellation and retained evidence.
  That overall run failed the then-too-strict peer test; only its UI test passed.
- Peer qualification passed on revision
  `039d30025956b527253bc16c60addb9081976379`,
  [run 42921514892, job 130197253391](https://github.com/afflom/stitch/actions/runs/42921514892/job/130197253391),
  in 37.6 seconds. Runtime source and candidate were unchanged from the UI pass.
  The retained serial output proves Linux 6.18.7 and actual serial shell execution.
  The initial ungranted ping failed. After bilateral grants, the first probe
  remained FAILED, the second naturally became REACHABLE and received a reply
  (17.297 ms). Reverse ping succeeded (15.498 ms). Receiver grant revocation
  caused the next ping to fail and did not advance the guest receive counter.
  Native authenticated RTC routing IDs were distinct; the observed channel was
  open with ICE connected. Frames include real ARP and IPv4 ICMP, not a synthetic
  injected echo. The guest runtime remained at 64 MiB with existing bounded
  command/result/filesystem policy and no public STUN, TURN or signaling.
- [Peer artifact 13812047028](https://github.com/afflom/stitch/actions/runs/42921514892/artifacts/13812047028)
  retains exact serial output, commands/results, packet headers and peer identities.
  ZIP SHA-256: `18589024dcac779cc1308aaeaa3ebf67793c5a33ab2a9c2eb9bfaac6a041a1cc`.
- [UI artifact 13811865759](https://github.com/afflom/stitch/actions/runs/42920254481/artifacts/13811865759)
  retains ready and stopped/reconciled screenshots. ZIP SHA-256:
  `c264d03cc91cff941cb95d1d8910fc7f5e615a80751825acf61279834e5e15d3`.

These observations qualify the stated hardware/operational scenarios on this
Chromium runner. They do not establish source publication, redistribution
clearance, public networking, cross-device behavior, automatic unique address
allocation, every budget-exhaustion path, or isolation. Later UI/lifecycle changes
need their own affected checks; this record does not silently qualify new code.
