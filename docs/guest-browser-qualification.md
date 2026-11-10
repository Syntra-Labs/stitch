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
