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
