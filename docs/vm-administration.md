# VM administration and command observations

The VM journey keeps shell execution, object mirroring and mesh Ethernet available,
with separate explicit object-sharing and Ethernet grants. Both default off.
Object sharing applies to subsequent database mirror attempts, not retroactive
export of the database. Revocation fences later mirror continuations, including
revoke/regrant races. It cannot remove a guest copy already delivered. Canonical
and optional alias filenames retain full SHA-256 roots, and input bytes are
snapshotted before the asynchronous host write. Mirroring is bounded to 16 MiB
per object. Ethernet accepts only integer-byte frames of 14–1518 bytes and requires
an open transport, current ready VM and grant. This operating limit excludes jumbo
frames. An open transport is not evidence that a remote peer is available or trusted.

Stop and destroy invalidate callbacks and revoke grants before invoking the
emulator. They serialize repeated clicks. Stop retains the stopped instance;
destroy is required before fresh boot. A failed operation retains the instance
and blocks boot and host bridges until explicit successful destroy. Host errors
mean the operation's outcome is unknown, not proof that the emulator stopped.
No control reverses commands or data already sent. Boot-failure cleanup follows the same quarantine rule: asynchronous destroy must
settle successfully before retry, and rejection retains the handle for explicit
destroy retry. Missing assets without an emulator instance remain directly retryable.

## Readiness and keyboard dispatch

A visible guest prompt only starts initialization; it does not grant Ready. The
host creates a fresh generation-scoped nonce challenge in 9p, then serializes one
initializer through the shipped keyboard adapter. That initializer checks or
mounts `host9p` at `/mnt`, reads the challenge, configures `eth0`, and writes the
nonce back to a separate response file. Ready requires completed synthetic typing
and an exact bounded host read of that fresh response from the same current VM.
Missing or mismatched responses remain booting until the existing readiness
failure deadline. Repeated polling never types another initializer concurrently.

This is a guest-controlled operational observation of a working shell/9p path,
not an isolation, honest-guest, correctness or exactly-once execution certificate.
The initializer and later command dispatches share a serialized typing queue.
The bundled `keyboard_send_text` Promise must resolve after its final synthetic
keystroke; adapters without that completion contract fail closed. Stop, destroy
and replacement fence all late initialization continuations. Both initializer
and command keystroke strings end with an actual newline, not literal `\\n`.

## Runtime and filesystem controls

Boot uses `autostart: false`. The current bundled v86 filesystem must expose the
reviewed local-9p adapter surface before `run()` is called. Missing methods or a
mounted backing filesystem refuse startup; no unbounded compatibility fallback
is used. The adapter is tied to copy/v86 source commit
`1e4f43c954701db9699fa976b27cc675f9971265`, especially `lib/filesystem.js` and
`src/browser/starter.js`. A future asset replacement must requalify this boundary.

The operator chooses a 1–300 second **whole-VM elapsed runtime allowance** before
boot. The default is 300 seconds, starting when the emulator is loaded and starts
running, including guest boot. It remains active after a short command observation
timeout or a completed command, so background processes and console work do not
escape it. Expiry requests a stop of the entire emulator and revokes host bridges.
A stopped instance must be destroyed before booting again or changing its
allowance. Browser timer scheduling, suspension and emulator cooperation can delay
stopping. This is not an instruction-accurate CPU quota, CPU-share scheduler,
wall-clock execution certificate, or kill guarantee against a broken emulator.

Configured guest RAM is 64 MiB, with 2 MiB VGA memory. It does not bound all emulator
or browser allocations. Guest-internal filesystems consume configured guest memory
in this diskless image. Host-backed 9p `/mnt` has separate pre-allocation admission:

- At most 16 MiB in one data-buffer allocation request.
- At most 64 MiB of cumulative admitted data-buffer allocation requests per
  instance, including object mirrors, shell scripts/results and directory listings.
  v86 growth slack is charged. Shrinking, unlinking, repeated directory reads and
  failed admitted operations do not refund the allowance. This conservative budget
  is not 64 MiB of usable free disk or a bound on all JS heap/transient overhead.
- At most 4096 cumulative inode allocations and 4096 directory-entry admissions;
  admitted names fit 255 UTF-8 bytes. Hard links consume directory-entry allowance.

The adapter wraps the bundled local allocator entrances (`ChangeSize`,
`CreateBinaryFile`, `CreateTextFile`, `FillDirectory`) before their allocations and
bounds inode/link creation. The filesystem's `total_size` field only affects
reported capacity; it is not relied on for enforcement. A refused allocation
quarantines subsequent guarded filesystem effects and requests whole-VM stop.
These are scoped filesystem controls, not a complete hostile-guest memory sandbox
or certification of every v86 device, lock, protocol table or browser allocation.

## Command observations and cancellation

Each shell command has a session-unique random instance prefix, generation and
monotonic sequence. Its retained handle captures the actual emulator object;
reads never switch to a replacement emulator. Only one execute wait runs at a
time, with at most 128 retained handles per node. Explicit disposal of completed
or known-not-dispatched evidence releases retained host output and command capacity.
Pending or unknown handles cannot be forgotten; disposal does not remove guest files.
Commands accept general shell syntax but reject empty input, NUL and input exceeding
16384 UTF-8 bytes. Observation time is bounded to 300000ms.

Result observation inspects regular-file metadata first and then calls
`fs9p.Read(id, 0, boundedLength)`, never unbounded `read_file`. The completion marker
is limited to 16 bytes; output is limited to 4 MiB per command and 16 MiB retained
across command handles. Metadata rejection happens before a read, and the captured
range cannot grow while that read awaits. Malformed or oversized results request
whole-VM stop, retain unknown completion and never certify command execution.

A short observation timeout retains unknown outcome and a handle for explicit
reconciliation while the same VM remains available. It does not stop the command;
the independent VM runtime deadline still applies. **Cancel and Stop VM** prevents
shell dispatch when it has not happened. After dispatch it requests a stop of the
whole VM, including unrelated guest/background work, rather than pretending that
shell signals can reliably kill arbitrary root commands or their descendants.
It interrupts a pending host result wait even if that API has stalled. Stop success
records `vm-stopped` separately from command outcome `unknown`: prior effects are
not rolled back. Rejection records `stop-unknown`, retains the quarantined instance
and requires explicit destroy retry. A pending stop remains pending, not success.
The compatibility `cancelCommandObservation` API uses these stronger semantics.

Reconciliation reads the same instance's completion flag/output and never resubmits
the command. The files are guest-controlled observations, not trustworthy execution
certificates. Browser reload loses command handles. The UI's retained-command
selector permits observation of any available earlier handle, not just the latest;
selection never executes or replays a command. No automatic replay is performed.

New typed boundary failures are `vm-boundary-unavailable`, `vm-filesystem-limit`,
`vm-output-limit`, `vm-observation-busy`, `vm-runtime-limit-invalid` and
`vm-runtime-active`, `vm-keyboard-instance-unavailable` and
`vm-keyboard-completion-unavailable`. An uncertain stop is a separate termination observation, not
proof of rollback or a resolved command.

The emulator kernel command line no longer explicitly disables mitigations or
trusts CPU entropy; it is empty and leaves kernel defaults in force. This source
configuration change does not alter host security settings or establish that the
old guest kernel provides modern mitigations. Linux 5.6 and emulator assets still
need maintenance and actual browser/security qualification.

## Verification boundary

`Stitch.VmAdministration` supplies source-derived predicates actually called before
object/Ethernet dispatch, command admission, result observation, filesystem
allocation/metadata admission and administration. Host object identity, valid frame
shape, readiness, clock scheduling and emulator success remain external observations.
Finite oracle tests and mock-emulator regression tests cover boundary values,
revocation, malformed Ethernet, closed transport, repeated clicks, timeout,
reconciliation, replacement, cancellation, stalled reads and failed cleanup.

`tests/vm-v86-boundary.test.js` additionally loads the **shipped v86 JS/WASM and
BIOS/kernel bytes** in Node. It checks real local-9p API compatibility, captured
result bytes, growth-slack charges, oversized-result refusal before `Read`,
pre-allocation refusal, and a successful stop of an actually running emulated CPU.
A second test boots the shipped guest through production `LinuxVmNode`, requires
its bidirectional 9p readiness response, executes a real shell command, captures
its unique marker and `Linux` output, and stops the CPU. This qualifies that
Node-hosted shell/9p round-trip, not browser, hostile-guest isolation, physical-host
or device-memory behavior. Chromium launch in this
execution environment is blocked by its Unix-socket restriction; live graphical
journeys have not been qualified here.

Focused commands:

- `node --test tests/vm-administration.test.js tests/vm-lifecycle.test.js tests/vm-v86-boundary.test.js`
- `node --test tests/runtime-admission.test.js tests/operator-ui.test.js`
- `npm test` and `python3 scripts/verify-custody.py`

The source predicates/limits changed in this resource-control revision. Historical
six-definition compiler attestations do not cover the additions; exact integrated
source verification must be regenerated against the final source. Neither a source
attestation nor these runtime checks certifies all browser or VM effects.

Gate sensitivity was checked by planting removal of `ChangeSize` admission in the
adapter. `node --test tests/vm-v86-boundary.test.js` failed on actual-v86 growth
accounting (`25` charged bytes versus expected `64`). Restoring the guard made the
same test pass. The mutation was not retained.
