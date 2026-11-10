// Real bundled v86 execution. This does not certify browser VGA/UI or peer transport.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const candidate = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.statSync(candidate).isFile()) throw Error('Usage: node vendor/guest/qualify-candidate.mjs CANDIDATE_IMAGE');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-v86-probe-'));
const loader = path.join(temp, 'libv86.cjs');
fs.copyFileSync(path.join(root, 'v86/libv86.js'), loader);
const { V86 } = createRequire(import.meta.url)(loader);
const bytes = p => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
let emulator, timer, tail = '', sent = false, finishing = false;
const began = Date.now();
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  if (error) { console.error('\nQUALIFICATION FAILED:', error.message); console.error('VGA snapshot:', emulator?.screen_adapter?.get_text_screen?.().join('\n') || '(unavailable)'); process.exitCode = 1; }
  else console.log(`\nQUALIFICATION PASSED: real boot, serial shell, guest eth0 presence/configuration, bidirectional 9p (${Date.now() - began} ms). Browser VGA/peer-network/reset checks remain separate.`);
  try { if (emulator) await Promise.race([emulator.destroy(), new Promise(resolve => setTimeout(resolve, 2000))]); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  process.exit(error ? 1 : 0);
}
process.on('unhandledRejection', error => { void finish(error); });
timer = setTimeout(() => { void finish(Error('No complete guest result within 180 seconds')); }, 180000);
try {
  emulator = new V86({
    wasm_path: path.join(root, 'v86/v86.wasm'),
    bios: { buffer: bytes(path.join(root, 'v86/seabios.bin')) },
    vga_bios: { buffer: bytes(path.join(root, 'v86/vgabios.bin')) },
    bzimage: { buffer: bytes(candidate) },
    memory_size: 64 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
    filesystem: {}, net_device: { type: 'ne2k' }, autostart: false,
    cmdline: 'console=tty0 console=ttyS0,115200 rdinit=/sbin/init',
  });
  emulator.add_listener('emulator-loaded', async () => {
    try { console.log('Bundled v86 loaded; booting real guest.'); await emulator.create_file('host-probe', new TextEncoder().encode('host-9p-value\n')); console.log('Host 9p input prepared; starting CPU.'); emulator.run(); }
    catch (error) { await finish(error); }
  });
  emulator.add_listener('serial0-output-byte', byte => {
    const c = String.fromCharCode(byte);
    process.stdout.write(c);
    tail = (tail + c).slice(-65536);
    if (!sent && /(?:#|~%)\s*$/.test(tail)) {
      sent = true;
      // Split success token so serial input echo alone cannot satisfy the check.
      emulator.serial0_send("mkdir -p /mnt/stitch-probe && mount -t 9p -o trans=virtio host9p /mnt/stitch-probe && test \"$(cat /mnt/stitch-probe/host-probe)\" = host-9p-value && printf 'guest-9p-value\\n' > /mnt/stitch-probe/guest-probe && test -d /sys/class/net/eth0 && ifconfig eth0 10.77.0.2 netmask 255.255.255.0 up && printf 'STITCH_%s\\n' GUEST_OK\n");
    }
    if (!finishing && tail.includes('STITCH_GUEST_OK')) {
      // Stop accepting serial completion before awaiting the independent host read.
      tail = ''; sent = true;
      void emulator.read_file('guest-probe').then(data => {
        if (new TextDecoder().decode(data) !== 'guest-9p-value\n') throw Error('Guest-to-host 9p contents differ');
        return finish();
      }).catch(finish);
    }
  });
} catch (error) { await finish(error); }
