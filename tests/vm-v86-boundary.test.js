import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installFilesystemControls, readBoundedVmFile, vmLimits } from '../src/layer4-compute/vm-administration.js';

// Exercise the shipped emulator and WASM, not a second filesystem implementation.
// No browser, network, guest shell, or isolation qualification is implied.
test('bundled v86 accepts guarded local 9p reads and rejects allocation before stopping its actual running CPU', { timeout: 15000 }, async t => {
  const local = path => readFileSync(new URL(`../${path}`, import.meta.url));
  const buffer = path => { const bytes = local(path); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); };
  const module = { exports: {} };
  new Function('module', 'exports', 'require', local('v86/libv86.js').toString())(module, module.exports, createRequire(import.meta.url));
  const vm = new module.exports.V86({
    wasm_fn: async imports => (await WebAssembly.instantiate(buffer('v86/v86.wasm'), imports)).instance.exports,
    memory_size: 64 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
    bios: { buffer: buffer('v86/seabios.bin') }, vga_bios: { buffer: buffer('v86/vgabios.bin') },
    bzimage: { buffer: buffer('images/buildroot-bzimage.bin') }, filesystem: {},
    autostart: false, screen_dummy: true, disable_speaker: true
  });
  await new Promise(resolve => vm.add_listener('emulator-loaded', resolve));
  t.after(() => vm.destroy());
  let stop, violation;
  const usage = installFilesystemControls(vm, error => { violation = error; stop = vm.stop(); });
  const bytes = new TextEncoder().encode('actual bundled v86 result');
  await vm.create_file('output', bytes);
  assert.deepEqual(await readBoundedVmFile(vm, 'output', bytes.length), bytes);
  const id = vm.fs9p.SearchPath('output').id;
  await vm.fs9p.Write(id, bytes.length, 1, Uint8Array.of(10));
  assert.equal(usage.allocatedBytes, bytes.length + Math.floor(3 * (bytes.length + 1) / 2));
  let reads = 0;
  const read = vm.fs9p.Read;
  vm.fs9p.Read = function (...args) { reads++; return read.apply(this, args); };
  await assert.rejects(readBoundedVmFile(vm, 'output', bytes.length), error => error.code === 'vm-output-limit');
  assert.equal(reads, 0);
  await vm.run();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(vm.is_running(), true); assert.ok(vm.get_instruction_counter() > 0);
  const originalSize = vm.fs9p.GetInode(id).size, originalBuffer = vm.fs9p.inodedata[id];
  assert.throws(() => vm.fs9p.ChangeSize(id, vmLimits.filesystemFileLimit + 1), error => error.code === 'vm-filesystem-limit');
  await stop;
  assert.equal(violation.code, 'vm-filesystem-limit'); assert.equal(vm.is_running(), false);
  assert.equal(vm.fs9p.GetInode(id).size, originalSize); assert.equal(vm.fs9p.inodedata[id], originalBuffer);
});
