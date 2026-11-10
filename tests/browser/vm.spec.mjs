import { test, expect, selectJourney } from './fixtures.mjs';

test('bundled v86 boots the actual guest, captures shell bytes and stops/destroys through operator controls', async ({ page }, testInfo) => {
  test.setTimeout(200_000);
  const loaded = new Set();
  page.on('response', response => {
    if (response.ok()) loaded.add(new URL(response.url()).pathname);
  });
  await page.goto('/');
  await selectJourney(page, 'vm');
  await expect(page.locator('#bootVmBtn')).toBeEnabled();
  await expect(page.locator('#runVmCmdBtn')).toBeDisabled();
  await page.locator('#vmLimitsPanel > summary').click();
  await expect(page.locator('#vmRuntimeSeconds')).toBeVisible();
  await page.locator('#vmRuntimeSeconds').fill('120');
  await page.locator('#bootVmBtn').click();
  await expect(page.locator('#bootVmBtn')).toBeDisabled();
  await expect(page.locator('#vmStatusLabel')).toContainText('ONLINE', { timeout: 70_000 });
  for (const path of ['/v86/libv86.js', '/v86/v86.wasm', '/v86/seabios.bin', '/v86/vgabios.bin', '/images/buildroot-bzimage.bin']) expect(loaded.has(path), `${path} loaded successfully`).toBe(true);
  await expect(page.locator('#vmShareObjects')).not.toBeChecked();
  await expect(page.locator('#vmShareEthernet')).not.toBeChecked();
  const marker = `stitch_native_guest_${crypto.randomUUID().replaceAll('-', '')}`;
  await page.locator('#vmCmdInput').fill(`printf '${marker}\\n'; uname -s`);
  await page.locator('#runVmCmdBtn').click();
  await expect(page.locator('#vmStdoutText')).toContainText(marker, { timeout: 20_000 });
  await expect(page.locator('#vmStdoutText')).toContainText('Linux');
  await expect(page.locator('#vmCommandOutcome')).toContainText('completed');
  await expect(page.locator('#vmCommandSelection option')).toHaveCount(1);
  await expect(page.locator('#vmActionStatus')).toContainText('VM-DONE');
  await page.locator('#reconcileVmCommandBtn').click();
  await expect(page.locator('#vmCommandSelection option')).toHaveCount(1);
  await expect(page.locator('#vmStdoutText')).toContainText(marker);
  await testInfo.attach('candidate-ready-operator', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await page.locator('#vmShareObjects').check();
  await page.locator('#stopVmBtn').click();
  await expect(page.locator('#vmShareObjects')).not.toBeChecked();
  await expect(page.locator('#runVmCmdBtn')).toBeDisabled();
  await expect(page.locator('#bootVmBtn')).toBeDisabled();
  await expect(page.locator('#destroyVmBtn')).toBeEnabled();
  await testInfo.attach('stopped-reconciled-operator', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await page.locator('#destroyVmBtn').click();
  await expect(page.locator('#bootVmBtn')).toBeEnabled();
  await expect(page.locator('#destroyVmBtn')).toBeDisabled();
  // Restart a fresh actual guest; the previous command evidence remains selected.
  await page.locator('#bootVmBtn').click();
  await expect(page.locator('#vmStatusLabel')).toContainText('ONLINE', { timeout: 70_000 });
  await page.locator('#vmShareEthernet').check();
  await page.locator('#vmCmdInput').fill('sleep 30; printf late_completion');
  await page.locator('#runVmCmdBtn').click();
  await expect(page.locator('#cancelVmObservationBtn')).toBeEnabled();
  // Wait until the genuine keyboard dispatch has completed; do not mistake a
  // before-dispatch cancellation for proof of whole-emulator termination.
  await expect(page.locator('#vmScreenContainer')).toContainText('sh /mnt/job_', { timeout: 10_000 });
  await page.locator('#cancelVmObservationBtn').click();
  await expect(page.locator('#vmCommandOutcome')).toContainText('vm-stopped');
  await expect(page.locator('#vmCommandOutcome')).toContainText('unknown');
  await expect(page.locator('#vmShareEthernet')).not.toBeChecked();
  await expect(page.locator('#runVmCmdBtn')).toBeDisabled();
  await expect(page.locator('#bootVmBtn')).toBeDisabled();
  await page.locator('#destroyVmBtn').click();
  await expect(page.locator('#bootVmBtn')).toBeEnabled();
  await expect(page.locator('#vmCommandSelection option')).toHaveCount(2);
  await page.locator('#vmCommandSelection').selectOption({ index: 0 });
  // Successful administration never erases resolved command evidence.
  await expect(page.locator('#vmCommandOutcome')).toContainText('completed');
  await expect(page.locator('#vmStdoutText')).toContainText(marker);
});
