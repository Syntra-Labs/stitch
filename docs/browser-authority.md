# Browser authority and operational care

Stitch separates three things: the saved signing key, independently accepted trust for a DNS name, and provider publication evidence. Changing one never silently changes either of the others. The implementation is origin-local browser functionality, not an Internet-wide key registry, recovery of lost secrets, or a claim of browser/provider qualification.

The pointer journey's **Signing authority, saved trust and storage care** panel keeps advanced controls out of the normal discovery flow. Each operation is explicit. Exact-key and exact-digest inputs are ordinary public values, never private-key imports. Closing the panel or editing the relevant scope clears consent and cancels a pending local key/trust change or journal-removal commit. Reopening does not repeat an operation.

## Saved signer lifecycle

**Set Up or Restore Saved Authority** creates one nonextractable Ed25519 key only if no saved authority record exists, or restores the existing active key. Setup never replaces a malformed record or a revocation tombstone. Normal startup restores only and never creates a replacement after a storage error.

To rotate or revoke, enter the exact currently saved public key and confirm the local operation. Rotation atomically replaces the signing key, increments its generation, and retains the former public key as a local retirement tombstone. Revocation retains the current public identity and generation but removes the store's private-key handle. Quota failure or transaction abort preserves the preceding record. Rotation is the explicit path from a revoked saved signer to a new key. Public retirement history is bounded to 64 entries; reaching the limit refuses another rotation instead of deleting history.

Neither operation changes the visible trust pin, a saved name anchor, a DNS record, or an observer head. Distribute the replacement public key independently and migrate each relevant name's trust separately. Existing signed pointers remain cryptographically valid. Another origin script or tab that already holds a CryptoKey handle cannot be forced to erase it. Stitch's saved-key signing API rechecks the active saved key, and a new journal claim atomically checks retired keys and saved trust before dispatch.

An origin-wide Web Lock serializes lifecycle changes with publication dispatch. A live writer holds that lock until its operation ends. There is no timeout takeover. Closing a tab releases browser locks but does not resolve an unknown provider write. Cross-origin and cross-device exclusion are not provided.

## Exact trusted heads and migration

An independently obtained public key is not made trustworthy by signing itself. Likewise, a timestamp or a valid signature does not establish globally latest state. Confirm the key, name and exact recent pointer digest independently before using **Save Current Exact Trust Anchor**. The candidate must match this live observer's admitted head, expected key and expected digest and must still be valid at the storage commit.

Once saved, a name's trust record constrains admission and new publication. Normal admitted successors advance its exact saved head transactionally before the in-memory head changes. A failed durable update leaves the live head unchanged. After reload, **Restore Saved Head to Current Pin** explicitly restores that exact saved head into an empty or identical observer with the same name and key. A different live head is never overwritten. A stale bootstrap or an earlier saved digest cannot replace a newer durable head.

**Migrate Saved Trust to Pasted Anchor** requires independent acceptance of the replacement key and exact recent digest, plus a complete signed pointer in the ordinary JSON input. The transaction compares the saved old key and digest, verifies the replacement signature, name, digest and validity, increments the trust generation and retains public migration history. It also supports an independently accepted recent same-key anchor when intervening pointer links are unavailable; those links are not claimed verified. Same-key rollback, same-revision forks and wrong adjacent predecessors are refused. A retired different key, or the currently revoked key, cannot be reactivated by migration.

Migration changes saved trust only. The visible pin and every existing live observer are unchanged. Enter the accepted replacement key in the pin input, then explicitly restore its saved head. Old observers fail future admission and new publication checks against the changed trust record. **Revoke Saved Trust Locally** retains its exact head and history, blocks future admission/new claims for that name and requires an independently accepted replacement key to resume. Trust migration history is bounded to 64 entries and never silently pruned.

## Unknown publication remains unresolved until observed

Key retirement and trust migration do not delete or bypass an unknown DNS intent. Supply its original exact name, zone and writer pin, load the saved publication, and reconcile it. A scoped provider token is used only for the call and is never saved. Reconciliation may observe the exact retained candidate even after local signing or trust revocation; it does not need the private key and cannot repeat the unknown mutation. An absent record does not prove a prior write never happened.

The origin lock spans provider reads, strict write-ahead intent commit, dispatch and settlement. Authority/trust changes wait for an in-flight dispatch. An aborted intent commit causes no provider mutation. Failed completion persistence leaves the candidate unknown for later read-only reconciliation. Provider record identities and published heads remain retained.

## Quota, persistence, eviction and export

**Inspect Origin Storage and Journal** reads the browser's origin-wide usage/quota estimate, persistence state and counts of retained/unknown publication records. Unsupported estimates are shown as unknown. The browser's estimate is not an application allocation promise. **Request Browser Storage Persistence** explicitly asks the browser for persistence; denial leaves all records in place. Even granted persistence does not protect against user clearing, device loss, private-session closure or every browser policy.

**Export Public Authority Journal** downloads canonical JSON containing only public signer identities/retirement history, saved trust anchors, exact unknown candidates, publication outcomes and provider identities. Private CryptoKey handles, tokens and transient mutation-owner identifiers are excluded. Keep this file and a recent independently trusted anchor outside the origin. It is not a private-key backup. There is intentionally no automatic journal-import path: a copied observation must not grant permission to repeat an uncertain provider write.

**Remove Definitely Refused Journal Entries** requires explicit confirmation. It removes only records whose outcome is definitely refused and that have no retained provider identity. Unknown records, published heads, refused updates that retain provider identity, and all key/trust tombstones are preserved. There is no clear-all or automatic eviction control. If quota blocks safe progress, export public evidence, free unrelated origin/browser storage through normal browser controls, and retry the exact local operation. Do not erase an unknown journal to obtain another write.

Storage loss cannot be detected reliably once all evidence is gone. A missing key or journal is not proof that the corresponding identity/effect never existed. Independently retained keys, recent anchors and provider observations are operational requirements, not something this browser feature can manufacture after total loss.

## Evidence boundary

`Stitch.Authority` owns the signer/trust generation transitions, explicit-operation admission, publication retirement gate, contextual control guard and conservative journal removal predicate. The handwritten host owns WebCrypto checks, transaction atomicity, the DOM and browser locks/storage APIs. Deterministic tests cover quota aborts, stale/canceled operations, concurrent dispatch versus revocation, restart, exact succession, migration and read-only reconciliation. Real supported-browser IndexedDB/Web Locks/persistence/eviction behavior and provider trials remain unqualified. These changes do not imply full-stack or whole-product completion.
