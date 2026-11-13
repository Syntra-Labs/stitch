import { test, expect, harness } from './fixtures.mjs';

test('real IndexedDB serializes concurrent setup and persists nonextractable Ed25519 signing across reload', async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([harness(page), harness(second)]);
  const database = `stitch-browser-${crypto.randomUUID()}`;
  async function setup(target) {
    return target.evaluate(async database => {
      const { BrowserAuthorityStore } = await import('/src/layer1-uor/browser-authority.js');
      const store = new BrowserAuthorityStore({ database });
      const key = await store.setupAuthority();
      let exported = false;
      try { await crypto.subtle.exportKey('pkcs8', key.privateKey); exported = true; } catch {}
      return { key: key.publicKey, extractable: key.privateKey.extractable, exported };
    }, database);
  }
  const [first, other] = await Promise.all([setup(page), setup(second)]);
  expect(first).toEqual(other);
  expect(first).toEqual({ key: expect.stringMatching(/^[a-f0-9]{64}$/), extractable: false, exported: false });
  await page.reload();
  const result = await page.evaluate(async database => {
    const { BrowserAuthorityStore } = await import('/src/layer1-uor/browser-authority.js');
    const { signPointer, PointerObserver } = await import('/src/layer1-uor/pointer.js');
    const authority = await new BrowserAuthorityStore({ database }).restoreAuthority();
    const name = 'browser.example.test', now = Date.now();
    const candidate = await signPointer({ version: 1, name, authorityKey: authority.publicKey,
      revision: 0, previousDigest: null, objectRoot: `sha256:${'f'.repeat(64)}`,
      validFromMs: now - 1000, validUntilMs: now + 60000 }, authority.privateKey);
    const observer = new PointerObserver({ name, trustedAuthorityKey: authority.publicKey, clock: () => now });
    const admitted = await observer.admit(candidate);
    return { key: authority.publicKey, digest: admitted.pointerDigest, expected: candidate.pointerDigest };
  }, database);
  expect(result.key).toBe(first.key);
  expect(result.digest).toBe(result.expected);
});

test('real cross-tab Web Lock blocks another owner and tab termination releases only the lock, not unknown intent', async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([harness(page), harness(second)]);
  const database = `stitch-lock-${crypto.randomUUID()}`, scope = 'browser-scope';
  await page.evaluate(async ({ database, scope }) => {
    const { BrowserAuthorityStore } = await import('/src/layer1-uor/browser-authority.js');
    const store = new BrowserAuthorityStore({ database });
    window.lockHeld = false;
    window.owner = store.exclusivePublication(scope, async () => {
      const candidate = { pointerDigest: 'sha256:' + 'a'.repeat(64) };
      await store.claimPublication(scope, { outcome: 'unknown', candidate, pointerDigest: candidate.pointerDigest });
      window.lockHeld = true;
      await new Promise(() => {});
    });
  }, { database, scope });
  await expect.poll(() => page.evaluate(() => window.lockHeld)).toBe(true);
  await second.evaluate(async ({ database, scope }) => {
    const { BrowserAuthorityStore } = await import('/src/layer1-uor/browser-authority.js');
    const store = new BrowserAuthorityStore({ database });
    window.secondAcquired = false;
    window.waiter = store.exclusivePublication(scope, async () => {
      window.retained = await store.readPublication(scope);
      window.secondAcquired = true;
    });
  }, { database, scope });
  const lockNames = { authority: `stitch-authority:${database}`, publication: `stitch-dns:${database}:${scope}` };
  await expect.poll(() => second.evaluate(async names => {
    const state = await navigator.locks.query();
    // Publication first owns the lifecycle lock, preventing rotation/revocation
    // during dispatch. The waiter must stop there, before requesting its DNS lock.
    return {
      authorityHeld: state.held.filter(x => x.name === names.authority).length,
      authorityPending: state.pending.filter(x => x.name === names.authority).length,
      publicationHeld: state.held.filter(x => x.name === names.publication).length,
      publicationPending: state.pending.filter(x => x.name === names.publication).length,
    };
  }, lockNames)).toEqual({ authorityHeld: 1, authorityPending: 1, publicationHeld: 1, publicationPending: 0 });
  expect(await second.evaluate(() => window.secondAcquired)).toBe(false);
  await page.close();
  await expect.poll(() => second.evaluate(() => window.secondAcquired)).toBe(true);
  expect(await second.evaluate(() => window.retained.outcome)).toBe('unknown');
  expect(await second.evaluate(() => window.retained.candidate.pointerDigest)).toBe(`sha256:${'a'.repeat(64)}`);
});
