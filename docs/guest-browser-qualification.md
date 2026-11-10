# Qualified guest candidate and production host evidence

The exact qualified image is now adopted with a durable corresponding-source
route in [the source notice](../vendor/guest/SOURCE-NOTICE.md). Native Prism acceptance remains a separate
SDK requirement. No product-release or whole-host certification is claimed here.

## Exact candidate

- Image SHA-256: `313a6b545290a2b47856b49bfcc4c7577469749b315932ae008d39fe70fc7f07`.
- Image size: 8,053,248 bytes; kernel: Linux 6.18.7.
- Emulator: the repository's existing v86 JS/Wasm/BIOS assets, with 64 MiB RAM.
- Required host boot arguments: `console=tty0 console=ttyS0,115200 rdinit=/init nomodeset`.
- Original image build: [run 42906244489](https://github.com/afflom/stitch/actions/runs/42906244489).
  Every qualification below reused that image; none rebuilt the guest/toolchain.

## Observed production scenarios

[Final Chromium operator run](https://github.com/afflom/stitch/actions/runs/42923694084/job/130204644360)
at diagnostic commit `d998432925e562577a7559b126af1437e933c0d5` passed in
23.3 seconds. The runner downloaded and SHA-checked the existing image, substituted
it and the exact boot arguments in its temporary checkout, then tested the actual
production UI and VM adapter:

- VGA and keyboard shell, host/guest 9p readiness nonce, shell output capture and
  retained command reconciliation;
- optional network settings initially collapsed, explicit static IPv4/prefix,
  correct pending and confirmed-stop/destruction observations;
- stop, destroy, fresh boot and cancellation after actual command dispatch;
- unknown prior command effects retained after confirmed stop/destruction;
- networking and runtime configuration locked while an instance is retained,
  then unlocked after confirmed destruction.

Four screenshots were inspected: ready, stopped, cancelled-command/confirmed-stop,
then destroyed/retained-unknown-command. They distinguish host termination from
command-effect uncertainty and show configuration unlock correctly. Artifact
`13811439946` has ZIP SHA-256
`51704acb32e72d5b5ac9f99de8865acf582e32b2522541e876909a51141886fc`.

[Chromium guest peer run](https://github.com/afflom/stitch/actions/runs/42921514892/job/130197253391)
at diagnostic commit `039d30025956b527253bc16c60addb9081976379` passed in
37.6 seconds. Two production VM instances used explicit `10.42.0.2/24` and
`10.42.0.3/24` configurations and a native, authenticated, host-only RTC channel.
The test exercised serial shell, default Ethernet denial, bilateral grants,
bidirectional ICMP, actual ARP/IPv4 packet delivery, receiver revocation and
unchanged filesystem budgets. No public signaling or STUN/TURN was used.

The intentionally denied first ping left normal guest neighbor-cache state.
The positive phase used at most three genuine bounded ping attempts, without
flushing that state: the first attempt remained FAILED; the second became
REACHABLE and returned a reply. Reverse ping then succeeded. Revocation caused
100% loss while the receiving VM's admitted-frame count stayed unchanged.
Artifact `13812047028` retains exact packet headers, command outputs, neighbor
observations and distinct authenticated routing identities. This is not a
promise of immediate packet delivery or automatic address uniqueness.

## Reuse and diagnosed deployment requirements

Buildroot's `/init` wrapper mounts devtmpfs; bypassing it with `/sbin/init` left
console device nodes absent. The candidate's modern graphics driver otherwise
switches v86 away from its legacy text console; `nomodeset` preserves that console.
A probe must recognize a real shell prompt, not a kernel `#1` banner. These are
host/probe corrections, not reasons to repeat an hour-long image build.

Runtime and source changes are tested by their owning checks. The final operator
fix changed UI settlement refresh, not the image, Ethernet forwarding or source
model; its source proof and previously qualified peer behavior were retained.
The complete feature-branch acceptance still runs after final integration.

## Distribution boundary

See [candidate source evidence](guest-candidate-evidence.md) for the verified
398,457,213-byte corresponding-source package, configurations, licenses and
hashes. Actions artifacts expire and are review outputs, not final source
hosting. The complete reviewed package is now preserved at the immutable
repository commit linked by the source notice; retain equivalent source access
alongside the image in every distribution. These checks do not establish cross-device
network availability, guest isolation, exhaustive resource-exhaustion behavior,
or native Prism artifact acceptance.
