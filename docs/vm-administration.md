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

Each shell command has a session-unique random instance prefix, generation and
monotonic sequence. The retained handle captures the actual emulator object;
reads never switch to a replacement emulator. Only one execute wait runs at a
time, with at most 128 retained handles per node. Explicit disposal of completed
or known-not-dispatched evidence releases retained host output and command capacity.
Pending or unknown handles cannot be forgotten; disposal does not remove guest files. Commands accept general shell
syntax but reject empty input, NUL and input exceeding 16384 UTF-8 bytes. Observation
time is bounded to 300000ms and observed output to 4 MiB. These host bounds are
not guest CPU/memory/disk quotas: arbitrary shell commands can still exhaust the
guest. The output limit is checked after the emulator API reads the file and does
not bound that API's internal allocation.

Timeout retains unknown outcome and a handle for explicit reconciliation. Cancel
ends observation, not guest execution; before dispatch it prevents the shell send.
An exception after dispatch remains unknown. Reconciliation reads the same
instance's completion flag and output and never resubmits the command. These files
are guest-controlled observations, not trustworthy execution certificates. Browser
reload loses handles. The UI offers observation of the latest handle; all retained
handles are accessible through the node API. No automatic replay is performed.

The emulator kernel command line no longer explicitly disables mitigations or
trusts CPU entropy; it is empty and leaves kernel defaults in force. This source
configuration change does not alter host security settings or establish that the
old guest kernel provides modern mitigations. Linux 5.6 and emulator assets still
need maintenance and actual browser/security qualification.

`Stitch.VmAdministration` supplies source-derived predicates actually called before
object/Ethernet dispatch, command admission, result observation and administration.
Host object identity, valid frame shape, readiness and emulator success are external
observations. Finite oracle tests and mock-emulator regression tests cover grants,
revocation, malformed Ethernet, closed transport, double clicks, unknown timeout,
reconciliation, replacement, cancellation and failed cleanup. They are not a live
VM/browser isolation qualification. The integrated 23-module source verification includes these definitions; see
`product/source-verification.json`. It does not certify browser or VM effects.

The isolated canonical module was subsequently checked and verified with the
pinned LexLean tool and Lean 4.32.1 in a one-module helper project. Attestation
`228cfe5f3d7848c73fc61fa82a1b10dba68b83ac321ddd74a873f9f205958e24`
audits its six definitions with no axioms. This is definition-level compiler
verification, not a new universal theorem set or aggregate application closure.
The canonical source file SHA-256 at that check was
`ba09b78f30729240508af5e4f33c7f0a63469fb5d5a72f1f4a81fafaa99e2286`.
