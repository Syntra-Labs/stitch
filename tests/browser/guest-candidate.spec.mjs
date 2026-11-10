import { test, expect, harness } from './fixtures.mjs';

test('candidate production VMs exchange real Ethernet over native RTC only with bilateral grants', async ({ page, context }, testInfo) => {
  test.skip(process.env.STITCH_CANDIDATE_QUALIFICATION !== '1', 'Runs only with the SHA-verified candidate substitution');
  test.setTimeout(200_000);
  const other = await context.newPage();
  const pages = [page, other], channelKey = `guest-${crypto.randomUUID()}`;
  try {
    await Promise.all(pages.map(async (target, index) => {
      await harness(target);
      await target.evaluate(() => { const base = document.createElement('base'); base.href = '/'; document.head.append(base); });
      await target.addScriptTag({ url: '/v86/libv86.js' });
      await target.evaluate(async ({ channelKey, index }) => {
        const { LinuxVmNode } = await import('/src/layer4-compute/index.js');
        const { WebRtcTransportNode } = await import('/src/layer5-transport/index.js');
        const screen = document.createElement('div');
        screen.innerHTML = '<div style="white-space:pre;font:12px monospace"></div><canvas style="display:none"></canvas>';
        document.body.append(screen);
        const offline = new LinuxVmNode({ screenContainer: screen });
        if (offline.networkConfiguration !== null || offline.ipAddress !== null) throw Error('Absent network must remain unconfigured');
        let refused = false;
        try { offline.setEthernetSharing(true); } catch (error) { refused = error.code === 'vm-network-required'; }
        if (!refused || offline.ethernetSharing) throw Error('Absent network must refuse Ethernet sharing');
        const state = window.guest = { statuses: [], serial: '', frames: 0 };
        const transport = state.transport = new WebRtcTransportNode({ peerId: `candidate-${index}`, channelKey,
          iceServers: [], publicSignaling: false, publicRelayConsent: () => false,
          onEvent: event => {
            if (event.type === 'mesh_message' && event.msg.type === 'eth_frame') {
              state.frames++;
              state.vm.handleIncomingEthFrame(event.msg.frame);
            }
          } });
        const vm = state.vm = new LinuxVmNode({ transport, screenContainer: screen, vmRuntimeMs: 180_000,
          network: { address: `10.42.0.${index + 2}`, prefixLength: 24 },
          onStatus: status => state.statuses.push(status) });
        transport.connect();
        vm.boot();
        vm.v86.add_listener('serial0-output-byte', byte => { state.serial = (state.serial + String.fromCharCode(byte)).slice(-65536); });
      }, { channelKey, index });
      await expect.poll(() => target.evaluate(() => window.guest.vm.booted), { timeout: 75_000 }).toBe(true);
      await expect.poll(() => target.evaluate(() => window.guest.transport.openPeers().length), { timeout: 20_000 }).toBe(1);
    }));
    const addresses = await Promise.all(pages.map(p => p.evaluate(() => window.guest.vm.ipAddress)));
    expect(addresses[0]).not.toBe(addresses[1]);
    const command = async (target, text) => target.evaluate(async text => new TextDecoder().decode(await window.guest.vm.executeShellCommand(text, 20_000)), text);
    // The boot nonce already read host input and wrote back over 9p. Also inspect
    // both real consoles and kernel identity instead of inferring them from boot.
    expect(await command(page, 'uname -r; printf stderr_probe >&2')).toContain('6.18.7');
    await page.evaluate(() => window.guest.vm.v86.serial0_send("printf 'SERIAL_%s\\n' QUALIFIED\n"));
    await expect.poll(() => page.evaluate(() => window.guest.serial.includes('SERIAL_QUALIFIED'))).toBe(true);
    expect(await command(page, `ping -c 1 -W 2 ${addresses[1]}; echo ping_exit:$?`)).toContain('ping_exit:1');
    expect(await page.evaluate(() => window.guest.vm.ethFramesSent)).toBe(0);
    await Promise.all(pages.map(p => p.evaluate(() => window.guest.vm.setEthernetSharing(true))));
    expect(await command(page, `ping -c 1 -W 3 ${addresses[1]}; echo ping_exit:$?`)).toContain('ping_exit:0');
    expect(await command(other, `ping -c 1 -W 3 ${addresses[0]}; echo ping_exit:$?`)).toContain('ping_exit:0');
    for (const target of pages) {
      const counters = await target.evaluate(() => ({ sent: window.guest.vm.ethFramesSent, received: window.guest.vm.ethFramesReceived }));
      expect(counters.sent).toBeGreaterThan(0); expect(counters.received).toBeGreaterThan(0);
    }
    await other.evaluate(() => window.guest.vm.setEthernetSharing(false));
    const before = await other.evaluate(() => window.guest.vm.ethFramesReceived);
    expect(await command(page, `ping -c 1 -W 2 ${addresses[1]}; echo ping_exit:$?`)).toContain('ping_exit:1');
    expect(await other.evaluate(() => window.guest.vm.ethFramesReceived)).toBe(before);
    await page.evaluate(() => window.guest.vm.setEthernetSharing(false));
    // Exact configured budgets are unchanged, even though this test does not
    // intentionally exhaust every limit (the source-derived boundary suite does).
    expect(await page.evaluate(async () => {
      const { vmLimits } = await import('/src/layer4-compute/vm-administration.js');
      return { limits: vmLimits, bytes: window.guest.vm.v86.fs9p.total_size };
    })).toMatchObject({ limits: { filesystemAllocationLimit: 67108864, filesystemMetadataLimit: 4096 }, bytes: 67108864 });
  } finally {
    for (const [index, target] of pages.entries()) {
      if (!target.isClosed()) {
        await testInfo.attach(`candidate-${index}-state`, { body: Buffer.from(JSON.stringify(await target.evaluate(() => {
          const g = window.guest;
          return g ? { statuses: g.statuses, serial: g.serial, frames: g.frames, lifecycle: g.vm.lifecycle,
            sent: g.vm.ethFramesSent, received: g.vm.ethFramesReceived } : null;
        }), null, 2)), contentType: 'application/json' });
        await target.evaluate(async () => { if (window.guest) { await window.guest.vm.destroy(); window.guest.transport.close(); } });
      }
    }
    await other.close();
  }
});
