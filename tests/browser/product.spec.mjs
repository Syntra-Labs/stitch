import { test, expect, selectJourney } from './fixtures.mjs';

test('shipped UI navigation preserves inputs, mesh hash and explicit disclosure guards', async ({ page }) => {
  await page.goto('/#browser-qualification');
  const nav = page.locator('#operatorJourneyNav button');
  await expect(nav).toHaveCount(6);
  await expect(page.locator('#meshPanel')).toBeVisible();
  await expect(page.locator('#reconnectBtn')).toBeDisabled();
  await expect(page.locator('#allowMeshSignalingInput')).not.toBeChecked();
  await expect(page.locator('#allowPublicRelayInput')).not.toBeChecked();
  await page.locator('#allowMeshSignalingInput').check();
  await expect(page.locator('#reconnectBtn')).toBeEnabled();
  // Consent alone never joins. No click of Join and no public traffic is allowed.
  await expect(page.locator('#peerCountLabel')).toHaveText('0');
  await page.locator('#allowMeshSignalingInput').uncheck();
  await expect(page.locator('#reconnectBtn')).toBeDisabled();

  const before = await page.evaluate(() => ({ hash: location.hash, history: history.length }));
  for (const name of ['objects', 'compute', 'vm', 'pointers', 'resources', 'mesh']) {
    await selectJourney(page, name);
    await expect(page.locator(`#${name}Panel`)).toBeFocused();
    await expect(page.locator('#operatorJourneyNav [aria-current="location"]')).toHaveCount(1);
    await expect(page.locator(`#${name}Evidence`)).not.toHaveText('');
    await expect(page.locator('section[id$="Panel"]:visible')).toHaveCount(1);
  }
  expect(await page.evaluate(() => ({ hash: location.hash, history: history.length }))).toEqual(before);

  await selectJourney(page, 'objects');
  await page.locator('#dbLabelInput').fill('retained-label.txt');
  await selectJourney(page, 'compute');
  await page.locator('#jobStepsInput').fill('3');
  await selectJourney(page, 'objects');
  await expect(page.locator('#dbLabelInput')).toHaveValue('retained-label.txt');
  await selectJourney(page, 'compute');
  await expect(page.locator('#jobStepsInput')).toHaveValue('3');
  // Keyboard navigation uses actual native button focus/activation.
  await page.locator('#operatorJourneyNav button[aria-controls="vmPanel"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#vmPanel')).toBeFocused();
  await expect(page.locator('#runVmCmdBtn')).toBeDisabled();
});

test('saved UI authority survives reload without silently pinning or replacing a key', async ({ page }) => {
  await page.goto('/');
  await selectJourney(page, 'pointers');
  await expect(page.locator('#authorityStorageStatus')).toContainText('No saved signing key');
  await page.locator('#authorityLifecyclePanel > summary').click();
  await page.locator('#saveAuthorityBtn').click();
  await expect(page.locator('#authorityStorageStatus')).toContainText('Saved');
  const key = await page.evaluate(async () => {
    const { BrowserAuthorityStore } = await import('/src/layer1-uor/browser-authority.js');
    return (await new BrowserAuthorityStore().restoreAuthority()).publicKey;
  });
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  await page.reload();
  await selectJourney(page, 'pointers');
  await expect(page.locator('#authorityStorageStatus')).toContainText('Saved signing key restored');
  await expect(page.locator('#pointerAuthorityInput')).toHaveValue('');
  expect(await page.evaluate(async () => {
    const { BrowserAuthorityStore } = await import('/src/layer1-uor/browser-authority.js');
    return (await new BrowserAuthorityStore().restoreAuthority()).publicKey;
  })).toBe(key);
});
