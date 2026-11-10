import { test, expect, harness } from './fixtures.mjs';

async function startNode(page, channelKey, label) {
  await harness(page);
  await page.evaluate(async ({ channelKey, label }) => {
    const { WebRtcTransportNode } = await import('/src/layer5-transport/index.js');
    const { LiveUorMeshDatabase } = await import('/src/layer3-storage/index.js');
    const { LiveDistributedComputeCoordinator } = await import('/src/layer4-compute/index.js');
    const events = [], errors = [];
    const transport = new WebRtcTransportNode({ peerId: label, channelKey, iceServers: [], publicSignaling: false, heartbeatIntervalMs: 250,
      publicRelayConsent: () => false,
      onEvent: event => {
        events.push(event);
        if (event.type === 'mesh_message') {
          const work = event.msg.type === 'compute_ckpt' ? compute.handleMeshMessage(event.from, event.msg)
            : event.msg.type.startsWith('uor_') ? db.handleMeshMessage(event.from, event.msg) : null;
          work?.catch(error => errors.push(error.code || error.message));
        }
      } });
    const db = new LiveUorMeshDatabase({ transport });
    const compute = new LiveDistributedComputeCoordinator({ transport, liveDb: db, allowPublicRelay: false });
    window.stitch = { transport, db, compute, events, errors };
    transport.connect();
  }, { channelKey, label });
}

async function attachHostDiagnostics(pages, testInfo) {
  const snapshots = [];
  for (const [index, page] of pages.entries()) {
    if (page.isClosed()) { snapshots.push({ page: index, closed: true }); continue; }
    try {
      snapshots.push(await page.evaluate(index => {
        const state = window.stitch;
        if (!state) return { page: index, initialized: false };
        const { transport, events, errors } = state;
        return {
          page: index, routingPeerId: transport.routingPeerId, generation: transport.generation,
          closed: transport.closed, bytesSent: transport.bytesSent, bytesReceived: transport.bytesReceived,
          peers: [...transport.peers].map(([remoteId, peer]) => ({
            remoteId, connection: peer.pc.connectionState, signaling: peer.pc.signalingState,
            ice: peer.pc.iceConnectionState, flow: peer.flow?.state,
            channel: peer.dc && { id: peer.dc.id, state: peer.dc.readyState, protocol: peer.dc.protocol,
              buffered: peer.dc.bufferedAmount, label: peer.dc.label },
          })),
          events: events.slice(-32).map(({ type, code, reason, outcome, remoteId, from, frames, bytes }) =>
            ({ type, code, reason, outcome, remoteId, from, frames, bytes })),
          errors: errors.slice(-32),
        };
      }, index));
    } catch (error) { snapshots.push({ page: index, diagnosticError: error.message }); }
  }
  await testInfo.attach('mesh-host-diagnostics', { body: Buffer.from(JSON.stringify(snapshots, null, 2)), contentType: 'application/json' });
}

async function connected(page, count = 1) {
  await expect.poll(() => page.evaluate(() => window.stitch.transport.openPeers().length), { timeout: 20_000 }).toBe(count);
}

test('native authenticated local RTC carries fragmented bytes, custody receipts and replayed checkpoints; reconnect fences old sessions', async ({ page, context }, testInfo) => {
  test.setTimeout(60_000);
  const other = await context.newPage();
  const channel = `browser-${crypto.randomUUID()}`;
  await startNode(page, channel, 'browser-a');
  await startNode(other, channel, 'browser-b');
  try {
    await Promise.all([connected(page), connected(other)]);
    const identities = await Promise.all([page, other].map(target => target.evaluate(() => {
      const t = window.stitch.transport, peer = t.openPeers()[0];
      return { own: t.routingPeerId, remote: peer.remoteId, authenticated: t.signaling.peers.has(peer.remoteId),
        ordered: peer.dc.ordered, protocol: peer.dc.protocol, iceServers: peer.pc.getConfiguration().iceServers };
    })));
    expect(identities[0].own).toBe(identities[1].remote);
    expect(identities[1].own).toBe(identities[0].remote);
    for (const identity of identities) {
      expect(identity.own).toMatch(/^key-/);
      expect(identity.authenticated).toBe(true);
      expect(identity.ordered).toBe(true);
      expect(identity.protocol).toBe('stitch.channel/1');
      expect(identity.iceServers).toEqual([]);
    }

    // Larger than the negotiated/default 64KiB application frame bound. Native
    // SCTP must carry all frames; equality is checked after real host delivery.
    const sentDigest = await page.evaluate(async () => {
      const value = 'é😀'.repeat(40_000);
      const bytes = new TextEncoder().encode(value);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
      const t = window.stitch.transport;
      if (!t.sendToPeer(t.openPeers()[0].remoteId, { type: 'browser_probe', value })) throw Error('Native channel refused the probe');
      return { digest, length: bytes.length };
    });
    await expect.poll(() => other.evaluate(() => window.stitch.events.filter(x => x.type === 'mesh_message' && x.msg.type === 'browser_probe').length)).toBe(1);
    const received = await other.evaluate(async () => {
      const packet = window.stitch.events.find(x => x.type === 'mesh_message' && x.msg.type === 'browser_probe');
      const bytes = new TextEncoder().encode(packet.msg.value);
      return { digest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join(''), length: bytes.length };
    });
    expect(received).toEqual(sentDigest);
    expect(await page.evaluate(() => window.stitch.events.some(x => x.type === 'channel_send_result' && x.outcome === 'submitted' && x.frames > 1))).toBe(true);

    const address = await page.evaluate(async () => (await window.stitch.db.put('native-browser-custody-é😀', { label: 'native.txt' })).addressHex);
    await expect.poll(() => page.evaluate(address => window.stitch.db.objects.get(address).placementStatus.committedFragments, address)).toBe(1);
    const partial = await other.evaluate(address => {
      const { db, transport } = window.stitch, object = db.objects.get(address);
      return { fragments: object.shards.filter(Boolean).length, held: [...object.heldIndices],
        verified: object.verified, readable: db.get(address).ok, source: object.source,
        sender: transport.openPeers()[0].remoteId };
    }, address);
    expect(partial.fragments).toBe(1);
    expect(partial.held).toEqual([0]);
    expect(partial.verified).toBe(false);
    expect(partial.readable).toBe(false);
    expect(partial.source).toBe(`webrtc:${partial.sender}`);
    const status = await page.evaluate(address => window.stitch.db.objects.get(address).placementStatus, address);
    expect(status.canRecoverFromCommitted).toBe(false);
    expect(status.distinctHolders).toBe(1);

    const jobId = `browser-job-${crypto.randomUUID()}`;
    const local = await page.evaluate(async jobId => {
      const job = await window.stitch.compute.startOrResumeJob({ jobId, totalSteps: 3, stepDelayMs: 100 });
      return { value: job.currentValueHex, step: job.stepIndex };
    }, jobId);
    await expect.poll(() => other.evaluate(jobId => window.stitch.compute.jobs.get(jobId)?.status, jobId)).toBe('completed');
    expect(await other.evaluate(jobId => {
      const job = window.stitch.compute.jobs.get(jobId);
      return { value: job.currentValueHex, step: job.stepIndex, verification: job.verification, source: job.sourceTag };
    }, jobId)).toEqual({ ...local, verification: 'replayed', source: `webrtc:${identities[0].own}` });

    // Keep an authentic old envelope. A new local incarnation must reject it,
    // even when the same peer display label and channel name are reused.
    const stale = await page.evaluate(() => window.stitch.transport.signaling.sign({ kind: 'ice', to: window.stitch.transport.openPeers()[0].remoteId, candidate: { candidate: 'old-incarnation' } }));
    await page.evaluate(() => window.stitch.transport.close());
    await other.evaluate(() => window.stitch.transport.close());
    expect(await page.evaluate(() => ({ peers: window.stitch.transport.peers.size, sent: window.stitch.transport.broadcast({ type: 'after_close' }) }))).toEqual({ peers: 0, sent: 0 });
    await other.evaluate(() => window.stitch.transport.connect());
    await page.evaluate(() => window.stitch.transport.connect());
    await Promise.all([connected(page), connected(other)]);
    expect(await other.evaluate(stale => window.stitch.transport.signaling.receive(stale), stale)).toBeNull();
    const newId = await page.evaluate(() => window.stitch.transport.routingPeerId);
    expect(newId).not.toBe(identities[0].own);
    for (const target of [page, other]) {
      expect(await target.evaluate(() => window.stitch.errors)).toEqual([]);
      expect(await target.evaluate(() => window.stitch.events.filter(x => x.type === 'signal_error'))).toEqual([]);
    }
  } catch (error) {
    await attachHostDiagnostics([page, other], testInfo).catch(() => {});
    throw error;
  } finally {
    for (const target of [page, other]) if (!target.isClosed()) await target.evaluate(() => window.stitch?.transport.close());
  }
});


test('native two-holder custody restores exact object bytes after writer RAM is cleared', async ({ page, context }, testInfo) => {
  test.setTimeout(50_000);
  const holders = [await context.newPage(), await context.newPage()];
  const pages = [page, ...holders], channel = `recovery-${crypto.randomUUID()}`;
  try {
    for (const [index, target] of pages.entries()) await startNode(target, channel, `recovery-${index}`);
    await Promise.all(pages.map(target => connected(target, 2)));
    const payload = `native-two-holder-recovery-${crypto.randomUUID()}-` + 'é😀'.repeat(1000);
    const address = await page.evaluate(async payload => (await window.stitch.db.put(payload, { label: 'recoverable.txt' })).addressHex, payload);
    await expect.poll(() => page.evaluate(address => window.stitch.db.objects.get(address).placementStatus.committedFragments, address)).toBe(2);
    expect(await page.evaluate(address => window.stitch.db.objects.get(address).placementStatus.canRecoverFromCommitted, address)).toBe(true);
    const remoteFragments = await Promise.all(holders.map(target => target.evaluate(address => {
      const object = window.stitch.db.objects.get(address);
      return { held: [...object.heldIndices], verified: object.verified };
    }, address)));
    expect(remoteFragments.flatMap(value => value.held).sort()).toEqual([0, 1]);
    expect(remoteFragments.every(value => value.verified === false)).toBe(true);

    await page.evaluate(async () => {
      await window.stitch.db.clearLocal();
      if (window.stitch.db.objects.size !== 0) throw Error('Local wipe did not clear writer objects');
      await window.stitch.db.syncFromNetwork('30m', { publicData: false });
    });
    await expect.poll(() => page.evaluate(address => window.stitch.db.get(address).ok, address)).toBe(true);
    expect(await page.evaluate(address => {
      const recovered = window.stitch.db.get(address);
      return { text: recovered.text, address: recovered.entry.addressHex, source: recovered.entry.source };
    }, address)).toEqual({ text: payload, address, source: expect.stringMatching(/^webrtc:key-/) });
    for (const target of pages) expect(await target.evaluate(() => window.stitch.errors)).toEqual([]);
  } catch (error) {
    await attachHostDiagnostics(pages, testInfo).catch(() => {});
    throw error;
  } finally {
    for (const target of pages) if (!target.isClosed()) await target.evaluate(() => window.stitch?.transport.close());
  }
});

test('native compute retains a reachable authenticated owner and resumes its checkpoint only after owner tab closes', async ({ page, context }, testInfo) => {
  test.setTimeout(60_000);
  const receiver = await context.newPage(), pages = [page, receiver];
  const channel = `compute-owner-${crypto.randomUUID()}`, jobId = `failover-${crypto.randomUUID()}`;
  try {
    await startNode(page, channel, 'compute-owner-label');
    await startNode(receiver, channel, 'compute-receiver-label');
    await Promise.all(pages.map(target => connected(target)));
    const owner = await page.evaluate(jobId => {
      const { transport, compute, errors } = window.stitch;
      // Six ADD3 steps from2 have the independent expected final value20 (0x14).
      // The bounded inter-step delay leaves a genuine unfinished owner task,
      // without pausing, replacing or mocking any coordinator/transport method.
      const program = { version: 1, bits: 64, initialValueHex: '0x2',
        instructions: Array.from({ length: 6 }, () => ({ op: 4, argHex: '0x3' })) };
      window.stitch.ownerWork = compute.startOrResumeJob({ jobId, program, stepDelayMs: 5000 })
        .catch(error => errors.push(error.code || error.message));
      return { key: transport.routingPeerId, label: transport.peerId };
    }, jobId);
    expect(owner.key).toMatch(/^key-/);
    expect(owner.key).not.toBe(owner.label);
    await expect.poll(() => receiver.evaluate(jobId => {
      const job = window.stitch.compute.jobs.get(jobId);
      return !!job && job.status === 'running' && job.verification === 'replayed' && job.stepIndex > 0;
    }, jobId)).toBe(true);
    const reachable = await receiver.evaluate(async jobId => {
      const { transport, compute } = window.stitch;
      const resumed = await compute.syncAndTakeOverJobs();
      const job = compute.jobs.get(jobId);
      return { resumed, runningLocally: compute.running.has(jobId), status: job.status,
        owner: job.ownerPeerId, step: job.stepIndex, value: job.currentValueHex,
        reachable: transport.openPeers().some(peer => peer.remoteId === job.ownerPeerId), source: job.sourceTag };
    }, jobId);
    expect(reachable).toEqual({ resumed: [], runningLocally: false, status: 'running', owner: owner.key,
      step: expect.any(Number), value: expect.any(String), reachable: true, source: `webrtc:${owner.key}` });
    expect(reachable.step).toBeLessThan(6);
    expect(reachable.value).toBe(`0x${(2 + 3 * reachable.step).toString(16)}`);

    // Closing the actual page destroys its native RTC connection and owner task.
    await page.close();
    await expect.poll(() => receiver.evaluate(ownerKey => {
      const { transport, events } = window.stitch;
      return transport.openPeers().length === 0 && transport.peers.size === 0 && events.some(event =>
        ['channel_close', 'peer_disconnected'].includes(event.type) && event.remoteId === ownerKey);
    }, owner.key), { timeout: 20_000 }).toBe(true);
    const result = await receiver.evaluate(async jobId => {
      const { transport, compute, db } = window.stitch;
      const retained = compute.jobs.get(jobId), step = retained.stepIndex, digest = retained.checkpoint.checkpointDigest;
      const updates = [];
      compute.onJobUpdate = job => {
        if (job.jobId === jobId && job.sourceTag.startsWith('local:')) updates.push({
          step: job.stepIndex, previous: job.checkpoint.previousDigest, owner: job.ownerPeerId });
      };
      const resumed = await compute.syncAndTakeOverJobs();
      await compute.running.get(jobId);
      const job = compute.jobs.get(jobId), stored = db.get(job.resultAddressHex);
      return { resumed, retainedStep: step, retainedDigest: digest, updates,
        receiverKey: transport.routingPeerId, owner: job.ownerPeerId, status: job.status,
        verification: job.verification, step: job.stepIndex, value: job.currentValueHex,
        stored: stored.ok && stored.entry.verified, result: stored.ok ? JSON.parse(stored.text) : null };
    }, jobId);
    expect(result.retainedStep).toBeGreaterThan(0);
    expect(result.retainedStep).toBeLessThan(6);
    expect(result.resumed).toEqual([jobId]);
    expect(result.receiverKey).toMatch(/^key-/);
    expect(result.owner).toBe(result.receiverKey);
    expect(result.owner).not.toBe(owner.key);
    expect(result.updates[0]).toEqual({ step: result.retainedStep + 1, previous: result.retainedDigest, owner: result.receiverKey });
    expect(result).toMatchObject({ status: 'completed', verification: 'replayed', step: 6, value: '0x14', stored: true });
    expect(result.result.jobId).toBe(jobId);
    expect(result.result.checkpoint).toMatchObject({ stepIndex: 6, stateHex: '0x14' });
    expect(await receiver.evaluate(() => window.stitch.errors)).toEqual([]);
  } catch (error) {
    await attachHostDiagnostics(pages, testInfo).catch(() => {});
    throw error;
  } finally {
    for (const target of pages) if (!target.isClosed()) await target.evaluate(() => window.stitch?.transport.close());
  }
});

test('native pre-join store repairs three distinct holders, replaces a departed holder and recovers after writer wipe', async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const channel = `placement-repair-${crypto.randomUUID()}`, pages = [page];
  try {
    await startNode(page, channel, 'repair-writer');
    const payload = `retained-before-peers-${crypto.randomUUID()}-é😀`;
    const address = await page.evaluate(async payload => (await window.stitch.db.put(payload)).addressHex, payload);
    expect(await page.evaluate(address => window.stitch.db.placementSummary(address).committedFragments, address)).toBe(0);
    const holders = [];
    for (let i = 0; i < 3; i++) {
      const holder = await context.newPage(); pages.push(holder); holders.push(holder);
      await startNode(holder, channel, `repair-holder-${i}`);
    }
    await Promise.all(pages.map(target => connected(target, 3)));
    await page.evaluate(address => window.stitch.db.repairPlacement(address), address);
    await expect.poll(() => page.evaluate(address => window.stitch.db.placementSummary(address).committedFragments, address)).toBe(3);
    const departedId = await holders[0].evaluate(() => window.stitch.transport.routingPeerId);
    await holders[0].evaluate(() => window.stitch.transport.close());
    await connected(page, 2);
    expect(await page.evaluate(address => window.stitch.db.placementSummary(address).committedFragments, address)).toBe(2);
    const replacement = await context.newPage(); pages.push(replacement);
    await startNode(replacement, channel, 'repair-replacement');
    await connected(page, 3);
    await page.evaluate(address => window.stitch.db.repairPlacement(address), address);
    await expect.poll(() => page.evaluate(address => window.stitch.db.placementSummary(address).committedFragments, address)).toBe(3);
    expect(await page.evaluate(({ address, departedId }) => {
      const { db } = window.stitch;
      return { copies: db.placementSummary(address).assertedCopies,
        departed: db.placements.get(address).copies.find(c => c.holder === departedId)?.status };
    }, { address, departedId })).toEqual({ copies: 4, departed: 'superseded' });
    await page.evaluate(async () => { await window.stitch.db.clearLocal(); await window.stitch.db.syncFromNetwork(); });
    await expect.poll(() => page.evaluate(address => window.stitch.db.get(address).ok, address)).toBe(true);
    expect(await page.evaluate(address => window.stitch.db.get(address).text, address)).toBe(payload);
    for (const target of pages) expect(await target.evaluate(() => window.stitch.errors)).toEqual([]);
  } catch (error) {
    await attachHostDiagnostics(pages, testInfo).catch(() => {});
    throw error;
  } finally {
    for (const target of pages) if (!target.isClosed()) await target.evaluate(() => window.stitch?.transport.close());
  }
});
