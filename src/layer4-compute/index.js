/**
 * @file src/layer4-compute/index.js
 * @description Layer 4: Distributed Compute Engine over UOR Content-Addressed Storage.
 * Executes deterministic Z/(2^n)Z PrimitiveOp reduction programs across churning worker nodes,
 * producing UOR Traces verified via `verifyTrace`.
 *
 * Compares 3 distributed execution strategies under worker churn:
 *   1. SingleWorkerRetryExecutor (restart from step 0 on worker drop)
 *   2. SpeculativeQuorumExecutor (2x redundant parallel workers)
 *   3. SurvivalCheckpointedExecutor (checkpoints intermediate Trace state into Layer-3 UOR store
 *      when worker survival probability P(alive) drops below threshold)
 */

import {
  Datum,
  PrimitiveOp,
  applyPrimitiveOp,
  mintContentAddress,
  TraceEvent,
  Trace,
  verifyTrace,
  Fnv1aHasher16
} from '../layer1-uor/index.js';
import { createCheckpoint, verifyCheckpoint, demoProgram, identifyProgram, MAX_PROGRAM_STEPS } from './replay.js';
import { shareAllowed, ethernetAllowed, commandAllowed, observationAllowed, administrationAllowed, forgetAllowed, validateCommand, vmLimits, VmBoundaryError, allocationAllowed, terminationRequired, installFilesystemControls, readBoundedVmFile } from './vm-administration.js';
import { ResourceAdmission, reserveNetwork } from '../layer2-schedulers/policy.js';
import { snapshotRecord } from '../layer1-uor/custody.js';
import { record, identifier, natural, digest, refuse } from '../layer1-uor/contracts.js';
import { computeSurvivalProbability } from '../layer2-schedulers/index.js';
import { vmCanBoot, vmIsBooting, vmCanExecute, vmCallbackCurrent, vmFailAllowed, startVm, failVm, readyVm } from '../layer1-uor/effects.js';

/**
 * Execute a full or partial sequence of UOR PrimitiveOp instructions on an initial Datum,
 * recording each step's resulting ContentAddress into a TraceEvent list.
 *
 * @param {object} params
 * @param {Datum} params.initialDatum
 * @param {Array<{op: number, arg?: Datum}>} params.program
 * @param {number} [params.startStep=0]
 * @param {number} [params.endStep=program.length]
 * @param {TraceEvent[]} [params.priorEvents=[]]
 */
export function executeProgramSlice({
  initialDatum,
  program,
  startStep = 0,
  endStep = program.length,
  priorEvents = []
}) {
  let current = initialDatum;
  const events = [...priorEvents];

  for (let step = startStep; step < endStep; step++) {
    const instr = program[step];
    current = applyPrimitiveOp(instr.op, current, instr.arg ?? null);
    const { address } = mintContentAddress(current.toBytes(), Fnv1aHasher16);
    events.push(new TraceEvent(step, instr.op, address));
  }

  return { datum: current, events };
}

/**
 * Finalize a completed execution into a UOR Trace and verify it via `verifyTrace`.
 */
export function finalizeAndVerifyExecution(datum, events) {
  const { fingerprint } = mintContentAddress(datum.toBytes(), Fnv1aHasher16);
  const trace = new Trace(events, fingerprint, datum.bits);
  const verification = verifyTrace(trace);
  return {
    datum,
    trace,
    verified: verification.ok, // Legacy field means structure-only, not execution correctness.
    verification: 'structure-only',
    certificate: verification.certificate ?? null
  };
}

/**
 * Deterministically benchmark the 3 distributed compute strategies across `taskCount` programs
 * of length `stepsPerTask` under a fixed sequence of worker drops.
 */
export function benchmarkComputeStrategies({
  taskCount = 20,
  stepsPerTask = 24,
  workerLambda = 0.08,
  dropStepModulo = 9
} = {}) {
  // Build deterministic UOR ring reduction program (e.g. affine + xor + succ steps in W64)
  const program = [];
  for (let s = 0; s < stepsPerTask; s++) {
    if (s % 3 === 0) {
      program.push({ op: PrimitiveOp.ADD, arg: Datum.w64(BigInt(s * 17 + 3)) });
    } else if (s % 3 === 1) {
      program.push({ op: PrimitiveOp.XOR, arg: Datum.w64(BigInt(0x5a5a5a5a + s)) });
    } else {
      program.push({ op: PrimitiveOp.SUCC });
    }
  }

  const strategies = [
    'single_worker_retry',
    'speculative_2x_quorum',
    'survival_checkpointed'
  ];

  return strategies.map(strategy => {
    let totalWallTicks = 0;
    let totalPrimitiveOpsExecuted = 0;
    let wastedPrimitiveOps = 0;
    let checkpointsWritten = 0;
    let verifiedCount = 0;

    for (let t = 0; t < taskCount; t++) {
      const seedDatum = Datum.w64(BigInt((t + 1) * 104729));

      if (strategy === 'single_worker_retry') {
        let step = 0;
        let curDatum = seedDatum;
        let events = [];
        let workerAge = 0;
        let globalTick = t * 5;

        while (step < stepsPerTask) {
          totalWallTicks++;
          globalTick++;
          workerAge++;
          totalPrimitiveOpsExecuted++;

          // Deterministic worker drop when workerAge hits dropStepModulo
          if (workerAge >= dropStepModulo && step < stepsPerTask - 1) {
            wastedPrimitiveOps += step + 1;
            step = 0;
            curDatum = seedDatum;
            events = [];
            workerAge = 0;
            // After respawn, next worker has longer window (2 * dropStepModulo)
            dropStepModulo += 0;
            // Allow second/third attempt to complete after retry penalty
            const res = executeProgramSlice({
              initialDatum: seedDatum,
              program,
              startStep: 0,
              endStep: stepsPerTask
            });
            totalPrimitiveOpsExecuted += stepsPerTask;
            totalWallTicks += stepsPerTask;
            curDatum = res.datum;
            events = res.events;
            break;
          } else {
            const slice = executeProgramSlice({
              initialDatum: curDatum,
              program,
              startStep: step,
              endStep: step + 1,
              priorEvents: events
            });
            curDatum = slice.datum;
            events = slice.events;
            step++;
          }
        }

        const out = finalizeAndVerifyExecution(curDatum, events);
        if (out.verified) verifiedCount++;
      } else if (strategy === 'speculative_2x_quorum') {
        // Two workers execute in parallel (2x compute cost, lower latency under single drop)
        const res = executeProgramSlice({
          initialDatum: seedDatum,
          program,
          startStep: 0,
          endStep: stepsPerTask
        });
        // Primary drops at dropStepModulo (wasting dropStepModulo ops), replica finishes in stepsPerTask ticks
        const primaryWasted = Math.min(stepsPerTask, dropStepModulo);
        totalPrimitiveOpsExecuted += stepsPerTask + primaryWasted;
        wastedPrimitiveOps += primaryWasted;
        totalWallTicks += stepsPerTask;

        const out = finalizeAndVerifyExecution(res.datum, res.events);
        if (out.verified) verifiedCount++;
      } else if (strategy === 'survival_checkpointed') {
        let step = 0;
        let curDatum = seedDatum;
        let events = [];
        let checkpointStep = 0;
        let checkpointDatum = seedDatum;
        let checkpointEvents = [];
        let workerAge = 0;

        while (step < stepsPerTask) {
          totalWallTicks++;
          workerAge++;
          totalPrimitiveOpsExecuted++;

          const slice = executeProgramSlice({
            initialDatum: curDatum,
            program,
            startStep: step,
            endStep: step + 1,
            priorEvents: events
          });
          curDatum = slice.datum;
          events = slice.events;
          step++;

          // Check worker survival probability P(alive) = exp(-lambda * workerAge)
          const pAlive = computeSurvivalProbability(workerLambda, workerAge);
          if (pAlive <= 0.60 && step < stepsPerTask) {
            // Proactively checkpoint current UOR Datum + partial Trace before drop
            checkpointStep = step;
            checkpointDatum = curDatum;
            checkpointEvents = [...events];
            checkpointsWritten++;
            workerAge = 0; // Fresh worker takes over from checkpoint
          }

          if (workerAge >= dropStepModulo && step < stepsPerTask) {
            // Unexpected drop: roll back only to last checkpoint instead of step 0
            wastedPrimitiveOps += step - checkpointStep;
            step = checkpointStep;
            curDatum = checkpointDatum;
            events = [...checkpointEvents];
            workerAge = 0;
          }
        }

        const out = finalizeAndVerifyExecution(curDatum, events);
        if (out.verified) verifiedCount++;
      }
    }

    const labelMap = {
      single_worker_retry: 'Single-Worker Restart (No Checkpoint)',
      speculative_2x_quorum: 'Speculative 2x Quorum (Active-Active)',
      survival_checkpointed: 'Survival-Checkpointed UOR Trace'
    };

    return {
      strategy: labelMap[strategy],
      tasks_completed: `${verifiedCount}/${taskCount}`,
      mean_latency_ticks: Number((totalWallTicks / taskCount).toFixed(1)),
      total_ring_ops: totalPrimitiveOpsExecuted,
      wasted_ring_ops: wastedPrimitiveOps,
      checkpoints_written: checkpointsWritten,
      trace_verified_rate: Number((verifiedCount / taskCount).toFixed(4))
    };
  });
}

/**
 * In-Browser x86 Linux 5.6 VM Node (`v86` WebAssembly emulator) with:
 *   1. 9p filesystem bridge (`/mnt`) synced with the Layer-3 UOR Database
 *   2. Virtual Ethernet NIC (`eth0`) bridged over Layer-5 WebRTC DataChannels
 *   3. Shell task execution producing UOR-addressed output artifacts
 */
export class LinuxVmNode {
  constructor({ transport, screenContainer, onStatus = () => {}, bootTimeoutMs = 60000, vmRuntimeMs = vmLimits.runtimeLimitMs }) {
    if (!Number.isFinite(bootTimeoutMs) || bootTimeoutMs <= 0 || bootTimeoutMs > 2147483647) throw new Error('Invalid VM boot timeout');
    if (!Number.isFinite(vmRuntimeMs) || vmRuntimeMs < 1000 || vmRuntimeMs > vmLimits.runtimeLimitMs) throw new VmBoundaryError('vm-runtime-limit-invalid', 'Invalid VM runtime allowance (1000–300000ms).');
    this.transport = transport;
    this.screenContainer = screenContainer;
    this.onStatus = onStatus;
    this.v86 = null;
    this.vmPhase = 'Idle';
    this.bootTimeoutMs = bootTimeoutMs;
    this.bootGeneration = 0;
    this.vmRuntimeMs = vmRuntimeMs;
    this.runtimeDeadline = null;
    this.filesystemUsage = null;
    this.boundaryReason = null;
    this.boundaryStop = null;
    this.bootPoll = null;
    this.bootDeadline = null;
    this.keyboardTail = Promise.resolve();
    this.bootProbe = null;
    this.shareGeneration = 0;
    this.objectSharing = false;
    this.ethernetGeneration = 0;
    this.ethernetSharing = false;
    this.adminBlocked = false;
    this.adminBusy = false;
    this.commandBusy = false;
    this.commands = new Map();
    this.commandSequence = 0;
    this.instanceId = globalThis.crypto.randomUUID();
    this.ethFramesSent = 0;
    this.ethFramesReceived = 0;
    this.ipAddress = `10.42.0.${(parseInt((this.transport?.peerId ?? '0000').slice(-4), 36) % 250) + 2}`;
  }

  get booted() { return vmCanExecute(this); }
  get booting() { return vmIsBooting(this); }
  get lifecycle() {
    return { phase: this.vmPhase.toLowerCase(), generation: this.bootGeneration, canBoot: !this.adminBlocked && !this.adminBusy && vmCanBoot(this), canExecute: vmCanExecute(this), instancePresent: !!this.v86, adminBusy: this.adminBusy, adminBlocked: this.adminBlocked, commandBusy: this.commandBusy, commandCapacity: this.commands.size < 128,
      runtimeAllowanceMs: this.vmRuntimeMs, filesystemUsage: this.filesystemUsage ? { ...this.filesystemUsage } : null, boundaryReason: this.boundaryReason,
      canAdminister: administrationAllowed(this), ...this.commandLifecycle(this.lastCommandId) };
  }

  // The UI can inspect any retained handle without changing the latest command
  // or inventing a second set of admission rules.
  commandLifecycle(id) {
    const command = this.commands.get(id);
    return {
      canCancelObservation: !!command && !command.cancelled && !this.adminBusy && !['completed', 'failed-before-dispatch', 'cancelled-before-dispatch'].includes(command.outcome) && (!command.dispatched || observationAllowed(this, command)),
      canForgetCommand: forgetAllowed(this, command),
      canReconcileCommand: !!command && (command.outcome === 'completed' || observationAllowed(this, command))
    };
  }

  setRuntimeAllowance(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 1000 || milliseconds > vmLimits.runtimeLimitMs)
      throw new VmBoundaryError('vm-runtime-limit-invalid', 'VM runtime allowance must be 1–300 seconds.');
    if (this.v86 || this.adminBusy) throw new VmBoundaryError('vm-runtime-active', 'Destroy the current instance before changing its runtime allowance.');
    this.vmRuntimeMs = milliseconds;
  }

  clearBootTimers() {
    if (this.bootPoll !== null) clearInterval(this.bootPoll);
    if (this.bootDeadline !== null) clearTimeout(this.bootDeadline);
    this.bootPoll = null;
    this.bootDeadline = null;
  }

  clearRuntimeDeadline() {
    if (this.runtimeDeadline !== null) clearTimeout(this.runtimeDeadline);
    this.runtimeDeadline = null;
  }

  enforceBoundary(reason) {
    if (this.boundaryStop || !this.v86) return this.boundaryStop;
    this.boundaryReason = reason;
    // administer synchronously fences grants and callbacks before its first await.
    this.boundaryStop = this.stop();
    return this.boundaryStop;
  }

  failBoot(generation, message) {
    if (!vmFailAllowed(this, generation)) return;
    // Invalidate listeners before cleanup, which may dispatch synchronous events.
    failVm(this, generation);
    this.clearBootTimers();
    this.clearRuntimeDeadline();
    const failed = this.v86;
    this.objectSharing = false;
    this.ethernetSharing = false;
    if (!failed) { this.onStatus({ state: 'error', message }); return; }
    // Retain the only handle while cleanup is pending or uncertain. Never allow
    // a replacement VM to hide an emulator which may still be running.
    this.adminBlocked = true;
    this.adminBusy = true;
    const cleaned = () => {
      this.v86 = null;
      this.adminBlocked = false;
      this.adminBusy = false;
      this.onStatus({ state: 'error', message });
    };
    const uncertain = error => {
      this.adminBusy = false;
      this.onStatus({ state: 'error', message: `${message} Cleanup outcome unknown: ${error.message}. Instance retained; explicitly retry Destroy before Boot.` });
    };
    try {
      if (typeof failed.destroy !== 'function') throw Error('VM destroy is unavailable');
      const result = failed.destroy();
      if (result && typeof result.then === 'function') Promise.resolve(result).then(cleaned, uncertain);
      else cleaned();
    } catch (error) { uncertain(error); }
  }

  sendGuestText(vm, generation, text) {
    const send = this.keyboardTail.then(async () => {
      if (this.v86 !== vm || this.bootGeneration !== generation || this.adminBlocked)
        throw new VmBoundaryError('vm-keyboard-instance-unavailable', 'VM changed before keyboard dispatch; input was not sent.');
      const pending = vm.keyboard_send_text(text, 10);
      // The shipped v86 method resolves after its last synthetic keystroke.
      // Undefined-returning adapters do not supply this contract.
      if (!pending || typeof pending.then !== 'function')
        throw new VmBoundaryError('vm-keyboard-completion-unavailable', 'VM keyboard adapter did not provide typing completion; input outcome is unknown.');
      await pending;
      if (this.v86 !== vm || this.bootGeneration !== generation || this.adminBlocked)
        throw new VmBoundaryError('vm-keyboard-instance-unavailable', 'VM changed during keyboard dispatch; input outcome remains unknown.');
    });
    this.keyboardTail = send.catch(() => {});
    return send;
  }

  boot() {
    if (this.adminBlocked || this.adminBusy || !vmCanBoot(this)) return;
    this.boundaryReason = null;
    this.boundaryStop = null;
    this.filesystemUsage = null;
    this.keyboardTail = Promise.resolve();
    this.bootProbe = null;
    startVm(this);
    const generation = this.bootGeneration;
    const V86Ctor = globalThis.V86 || globalThis.V86Starter;
    if (!V86Ctor) {
      this.failBoot(generation, 'libv86.js not loaded; retry Boot after the asset is available.');
      return;
    }

    this.onStatus({ state: 'booting', ip: this.ipAddress });
    try {
      const vm = new V86Ctor({
        wasm_path: './v86/v86.wasm',
        memory_size: 64 * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        screen_container: this.screenContainer,
        bios: { url: './v86/seabios.bin' },
        vga_bios: { url: './v86/vgabios.bin' },
        bzimage: { url: './images/buildroot-bzimage.bin' },
        cmdline: '',
        filesystem: {},
        net_device: { type: 'ne2k' },
        autostart: false
      });
      this.v86 = vm;
      const current = () => vmCallbackCurrent(this, generation, vm);
      let vmStarted = false;
      vm.add_listener('emulator-loaded', () => {
        if (!current() || vmStarted) return;
        try {
          if (typeof vm.run !== 'function') throw new VmBoundaryError('vm-boundary-unavailable', 'VM run control is unavailable.');
          this.filesystemUsage = installFilesystemControls(vm, error => this.enforceBoundary(error.message));
          this.runtimeDeadline = setTimeout(() => {
            if (current() && terminationRequired(false, true, false))
              this.enforceBoundary(`VM runtime allowance of ${this.vmRuntimeMs}ms elapsed. The whole VM is being stopped; guest effects remain unknown.`);
          }, this.vmRuntimeMs);
          vmStarted = true;
          Promise.resolve(vm.run()).catch(error => this.failBoot(generation, `VM start failed: ${error.message}`));
        } catch (error) { this.failBoot(generation, error.message); }
      });
      vm.add_listener('download-error', () => {
        if (current()) this.failBoot(generation, 'VM asset download failed; retry Boot when assets are available.');
      });
      vm.add_listener('net0-send', frameBytes => {
        if (!ethernetAllowed(this, current(), frameBytes)) return;
        this.ethFramesSent++;
        const grantGeneration = this.ethernetGeneration;
        this.transport.broadcast({ type: 'eth_frame', from: this.transport.peerId, frame: Array.from(frameBytes) },
          { consentCurrent: () => grantGeneration === this.ethernetGeneration && ethernetAllowed(this, current(), frameBytes) });
      });
      if (!current()) return;
      this.bootDeadline = setTimeout(() => {
        if (current()) this.failBoot(generation, `VM readiness was not observed within ${this.bootTimeoutMs}ms; retry Boot explicitly.`);
      }, this.bootTimeoutMs);
      let pollBusy = false;
      this.bootPoll = setInterval(async () => {
        if (!current() || !this.booting || !vmStarted || pollBusy) return;
        pollBusy = true;
        try {
          if (!this.bootProbe) {
            const text = Array.from(this.screenContainer.querySelectorAll('span'))
              .map(s => s.innerText).join('').replace(/[\s\u00a0]+/g, ' ').trim();
            // A prompt starts initialization; it never establishes readiness.
            if (!(text.includes('~%') || /#(?:\s|$)/.test(text))) return;
            const suffix = `${this.instanceId}_${generation}`;
            const nonce = globalThis.crypto.randomUUID().replaceAll('-', '');
            const probe = this.bootProbe = { inputName: `boot_in_${suffix}`, responseName: `boot_ready_${suffix}`, nonce, typingCompleted: false };
            await vm.create_file(probe.inputName, new TextEncoder().encode(nonce));
            if (!current() || this.adminBlocked) return;
            // A preexisting mount is normal for the shipped guest. If its init
            // mount failed, retry only that setup step. The response can arrive
            // only after the shell reads host input and writes back over 9p.
            const setup = `mkdir -p /mnt; { grep -q '^host9p /mnt 9p ' /proc/mounts || mount -t 9p -o trans=virtio host9p /mnt; } && [ "$(cat /mnt/${probe.inputName})" = '${nonce}' ] && ifconfig eth0 ${this.ipAddress} netmask 255.255.255.0 up && printf '%s' '${nonce}' > /mnt/${probe.responseName}\n`;
            await this.sendGuestText(vm, generation, setup);
            probe.typingCompleted = true;
          }
          const probe = this.bootProbe;
          const response = await readBoundedVmFile(vm, probe.responseName, 32);
          const expected = new TextEncoder().encode(probe.nonce);
          const exact = !!response && response.length === expected.length && response.every((byte, i) => byte === expected[i]);
          if (current() && probe.typingCompleted && exact) {
            this.clearBootTimers();
            readyVm(this, generation, vm, true);
            this.onStatus({ state: 'online', ip: this.ipAddress });
          }
        } catch (error) {
          this.failBoot(generation, `VM boot failed: ${error.message}`);
        } finally { pollBusy = false; }
      }, 250);
    } catch (error) {
      this.failBoot(generation, `VM boot failed: ${error.message}`);
    }
  }

  handleIncomingEthFrame(frameArray) {
    if (!ethernetAllowed(this, !!this.v86, frameArray)) return false;
    this.ethFramesReceived++;
    this.v86.bus.send('net0-receive', new Uint8Array(frameArray));
  }

  async mountUorObject(addressHex, bytes, label = '') {
    const vm = this.v86, generation = this.bootGeneration, shareGeneration = this.shareGeneration;
    if (!vm || !shareAllowed(this, true)) return false;
    const current = () => shareAllowed(this, shareGeneration === this.shareGeneration && vmCallbackCurrent(this, generation, vm));
    try {
      digest(addressHex);
      if (!(bytes instanceof Uint8Array) || bytes.length > 16 * 1024 * 1024 || typeof label !== 'string') return false;
      const snapshot = bytes.slice(), fullRoot = addressHex.slice('sha256:'.length);
      const filename = `uor_sha256_${fullRoot}.bin`;
      await vm.create_file(filename, snapshot);
      if (!current()) return false;
      if (label) {
        const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        // Labels are convenience aliases in a disjoint namespace, never object
        // identity. Every alias retains the complete content digest.
        await vm.create_file(`uor_label_${safeLabel}_sha256_${fullRoot}.bin`, snapshot.slice());
      }
      return current();
    } catch {
      return false;
    }
  }

  /**
   * Execute a shell command inside the booted Linux 5.6 VM, capture stdout via `/mnt/`,
   * and return the resulting bytes so they can be stored and replicated as a UOR object.
   */
  setObjectSharing(granted) {
    if (typeof granted !== 'boolean') throw Error('Explicit Boolean grant required');
    this.shareGeneration++;
    this.objectSharing = granted;
    return granted;
  }

  setEthernetSharing(granted) {
    if (typeof granted !== 'boolean') throw Error('Explicit Boolean grant required');
    this.ethernetGeneration++;
    this.ethernetSharing = granted;
    return granted;
  }

  async administer(action) {
    if (!['stop', 'destroy'].includes(action)) throw Error('Invalid VM administration action');
    if (!administrationAllowed(this)) return false;
    const vm = this.v86;
    this.adminBusy = true;
    this.adminBlocked = true;
    this.objectSharing = false;
    this.ethernetSharing = false;
    this.clearBootTimers();
    this.clearRuntimeDeadline();
    // Invalidate all pending callbacks BEFORE invoking a possibly reentrant host effect.
    this.bootGeneration++;
    this.vmPhase = 'Failed';
    for (const command of this.commands.values()) if (command.vm === vm && command.outcome !== 'completed') {
      if (command.dispatched) { command.outcome = 'unknown'; command.termination = 'stop-pending'; }
      else if (command.outcome === 'pending') command.outcome = 'cancelled-before-dispatch';
      command.interrupt?.();
    }
    try {
      if (typeof vm[action] !== 'function') throw Error(`VM ${action} is unavailable`);
      const pending = vm[action]();
      try { this.onStatus({ state: 'stopping', message: `${this.boundaryReason ? this.boundaryReason + ' ' : ''}VM ${action} requested; awaiting emulator confirmation. Guest effects remain unknown.` }); }
      catch { /* An observing UI callback must not prevent or abandon termination. */ }
      await pending;
      if (action === 'destroy') {
        this.v86 = null;
        this.vmPhase = 'Idle';
        this.adminBlocked = false;
      }
      for (const command of this.commands.values()) if (command.vm === vm && command.dispatched && command.outcome !== 'completed') command.termination = action === 'stop' ? 'vm-stopped' : 'vm-destroyed';
      this.onStatus({ state: 'offline', message: `${this.boundaryReason ? this.boundaryReason + ' ' : ''}${action === 'stop' ? 'VM stopped. Destroy before booting a fresh VM.' : 'VM destroyed. Guest effects are not rolled back.'}` });
      return true;
    } catch (error) {
      for (const command of this.commands.values()) if (command.vm === vm && command.dispatched && command.outcome !== 'completed') command.termination = 'stop-unknown';
      this.onStatus({ state: 'error', message: `VM ${action} outcome unknown: ${error.message}. Grants revoked; instance retained for explicit destroy retry.` });
      return false;
    } finally { this.adminBusy = false; }
  }

  stop() { return this.administer('stop'); }
  destroy() { return this.administer('destroy'); }

  async cancelCommand(id) {
    const command = this.commands.get(id);
    if (!command || command.cancelled || ['completed', 'failed-before-dispatch', 'cancelled-before-dispatch'].includes(command.outcome)) return false;
    command.cancelled = true;
    command.outcome = command.dispatched ? 'unknown' : 'cancelled-before-dispatch';
    command.interrupt?.();
    if (!command.dispatched) return true;
    if (command.vm !== this.v86 || command.generation !== this.bootGeneration || this.adminBlocked) return false;
    command.termination = 'stop-pending';
    if (terminationRequired(true, false, false))
      return await this.enforceBoundary('Command cancellation requested. Cancellation stops the whole VM, including other guest work. Prior effects are not rolled back.');
    return false;
  }

  // Compatibility name retains the stronger whole-VM cancellation semantics.
  cancelCommandObservation(id) { return this.cancelCommand(id); }

  forgetCommand(id) {
    const command = this.commands.get(id);
    if (!forgetAllowed(this, command)) return false;
    // Explicit operator disposal only. Unknown effects remain observable.
    this.commands.delete(id);
    delete command.output;
    command.vm = null;
    if (this.lastCommandId === id) this.lastCommandId = [...this.commands.keys()].at(-1);
    return true;
  }

  commandEvidence(id) {
    const command = this.commands.get(id);
    return command ? { id, generation: command.generation, outcome: command.outcome, dispatched: command.dispatched, termination: command.termination ?? 'not-requested' } : null;
  }

  async reconcileCommand(id) {
    const command = this.commands.get(id);
    if (!command) throw Error('Unknown VM command handle');
    if (command.outcome === 'completed') return command.output.slice();
    if (!observationAllowed(this, command)) throw Error('Command belongs to an unavailable VM instance; completion remains unknown.');
    if (command.reading) throw new VmBoundaryError('vm-observation-busy', 'This command result is already being observed.');
    command.reading = true;
    try {
      const observe = operation => command.interruption ? Promise.race([operation, command.interruption]) : operation;
      const done = await observe(readBoundedVmFile(command.vm, command.doneName, 16));
      if (!observationAllowed(this, command)) throw Error('VM replaced during command observation; completion remains unknown.');
      if (!done?.length) return null;
      const retained = [...this.commands.values()].reduce((sum, value) => sum + (value.output?.length ?? 0), 0);
      const output = await observe(readBoundedVmFile(command.vm, command.outName, Math.max(0, Math.min(vmLimits.outputLimit, vmLimits.retainedOutputLimit - retained))));
      if (!observationAllowed(this, command)) throw Error('VM replaced during output read; completion remains unknown.');
      if (output === null) return null;
      const retainedNow = [...this.commands.values()].reduce((sum, value) => sum + (value.output?.length ?? 0), 0);
      if (!allocationAllowed(retainedNow, output.length, vmLimits.retainedOutputLimit))
        throw new VmBoundaryError('vm-output-limit', 'Retained output allowance reached.');
      command.output = output ?? new Uint8Array(0);
      command.outcome = 'completed';
      return command.output.slice();
    } catch (error) {
      if (['vm-output-limit', 'vm-boundary-unavailable'].includes(error.code)) {
        command.outcome = 'unknown';
        await this.enforceBoundary(error.message);
      }
      throw error;
    } finally { command.reading = false; }
  }

  async executeShellCommand(commandStr, timeoutMs = 6000) {
    validateCommand(commandStr, timeoutMs);
    if (!this.v86 || !commandAllowed(this)) throw Error('VM command refused: not ready, busy, quarantined, or command handle capacity reached.');
    this.commandBusy = true;
    const vm = this.v86, generation = this.bootGeneration;
    const id = `${this.instanceId}_${generation}_${++this.commandSequence}`;
    const command = { id, vm, generation, dispatched: false, outcome: 'pending', cancelled: false,
      outName: `out_${id}.txt`, doneName: `done_${id}.flag` };
    this.commands.set(id, command);
    this.lastCommandId = id;
    const failure = message => Object.assign(new Error(message), { commandId: id, outcome: command.outcome });
    command.interruption = new Promise((resolve, reject) => {
      command.interrupt = () => reject(failure(command.dispatched
        ? 'VM replaced or stopped during command observation; completion remains unknown.' : 'Command cancelled before shell dispatch.'));
    });
    // A cancellation can arrive between host calls. Always observe its rejection.
    command.interruption.catch(() => {});
    try {
      const scriptName = `job_${id}.sh`;
      const scriptBody = `#!/bin/sh\n(${commandStr}) > /mnt/${command.outName} 2>&1\necho OK > /mnt/${command.doneName}\n`;
      await Promise.race([vm.create_file(scriptName, new TextEncoder().encode(scriptBody)), command.interruption]);
      if (command.cancelled || this.v86 !== vm || this.bootGeneration !== generation || this.adminBlocked) {
        command.outcome = 'cancelled-before-dispatch';
        throw failure('Command cancelled before shell dispatch.');
      }
      // Even a throwing keyboard adapter may have dispatched input: retain unknown.
      command.dispatched = true;
      await Promise.race([this.sendGuestText(vm, generation, `sh /mnt/${scriptName}\n`), command.interruption]);
      const t0 = performance.now();
      while (!command.cancelled && performance.now() - t0 < timeoutMs) {
        if (!observationAllowed(this, command)) break;
        const output = await this.reconcileCommand(id);
        if (output !== null) return output;
        await Promise.race([new Promise(resolve => setTimeout(resolve, 200)), command.interruption]);
      }
      command.outcome = 'unknown';
      throw failure(command.cancelled || this.adminBlocked
        ? `Command observation ended; completion is unknown. VM termination: ${command.termination ?? 'stop-pending'}. Prior guest effects are not rolled back.`
        : `VM command observation ended after ${timeoutMs}ms; completion is unknown and the guest command was not cancelled. Reconcile handle ${id}, or Cancel and stop VM; do not replay automatically. The VM runtime allowance continues independently.`);
    } catch (error) {
      if (error.code === 'vm-keyboard-completion-unavailable') await this.enforceBoundary(error.message);
      if (command.outcome === 'pending') command.outcome = command.dispatched ? 'unknown' : 'failed-before-dispatch';
      error.commandId = id; error.outcome = command.outcome;
      throw error;
    } finally { this.commandBusy = false; }
  }

}

/**
 * Live Distributed Compute Coordinator over WebRTC + Warm Relay Cache.
 * Runs multi-step UOR Z/(2^64)Z programs with real network checkpointing:
 * if the executing browser tab closes mid-job, another open tab (or a newly
 * opened tab reading the warm cache) resumes execution from the last verified step!
 */
export class LiveDistributedComputeCoordinator {
  constructor({ transport, liveDb, onJobUpdate = () => {}, allowPublicRelay = false, maxJobs = 128, admission = liveDb?.admission ?? transport?.admission ?? new ResourceAdmission() }) {
    natural(maxJobs, 4096);
    this.transport = transport;
    this.liveDb = liveDb;
    this.onJobUpdate = onJobUpdate;
    this.allowPublicRelay = allowPublicRelay;
    this.maxJobs = maxJobs;
    this.admission = admission;
    this.jobs = new Map();
    this.running = new Map();
    this.ingress = Promise.resolve();
    this.pendingIngress = 0;
    this.maxPendingIngress = 128;
  }

  async ownerIdentity() {
    // Initialize the authenticated route before publishing an owner. Display labels
    // may differ across peers and must not masquerade as reachability identities.
    const session = this.transport.signaling;
    await session?.identity?.();
    if (session !== this.transport.signaling) refuse('transport-session-changed');
    return this.transport.routingPeerId ?? this.transport.peerId;
  }

  async handleMeshMessage(fromPeerId, msg) {
    if (!msg || msg.type !== 'compute_ckpt') return false;
    return this.ingestCheckpoint(msg, `webrtc:${fromPeerId}`);
  }

  ingestCheckpoint(packet, sourceTag = 'remote') {
    // Serialize validation plus commit: two concurrent packets must not overwrite a newer head.
    // Snapshot before queueing; later caller mutation cannot alter the admitted message.
    if (this.pendingIngress >= this.maxPendingIngress) return Promise.resolve(false);
    try { packet = snapshotRecord(packet); } catch { return Promise.resolve(false); }
    this.pendingIngress++;
    const task = this.ingress.then(() => this.acceptCheckpoint(packet, sourceTag)).finally(() => { this.pendingIngress--; });
    this.ingress = task.catch(() => {});
    return task;
  }

  async acceptCheckpoint(packet, sourceTag) {
    try {
      record(packet, ['type', 'jobId', 'program', 'checkpoint', 'ownerPeerId']);
      if (packet.type !== 'compute_ckpt') refuse('unsupported-checkpoint');
      identifier(packet.jobId); identifier(packet.ownerPeerId);
      const verification = await verifyCheckpoint(packet.program, packet.checkpoint, undefined, { admission: this.admission });
      const existing = this.jobs.get(packet.jobId);
      if (existing) {
        if (existing.checkpoint.jobId !== packet.checkpoint.jobId) refuse('job-conflict');
        if (packet.checkpoint.stepIndex <= existing.stepIndex) {
          if (packet.checkpoint.stepIndex === existing.stepIndex &&
              packet.checkpoint.stateHex !== existing.currentValueHex) refuse('job-conflict');
          return false;
        }
        // Every accepted state is replayed independently. Missing network checkpoints are
        // allowed, but a direct successor must bind the retained predecessor.
        if (packet.checkpoint.stepIndex === existing.stepIndex + 1) {
          await verifyCheckpoint(packet.program, packet.checkpoint, existing.checkpoint, { admission: this.admission });
        }
      } else if (this.jobs.size >= this.maxJobs) refuse('job-capacity');
      this.admission.reserve('checkpoint', { storageBytes: new TextEncoder().encode(JSON.stringify(packet)).length });
      const job = { jobId: packet.jobId, program: structuredClone(packet.program),
        checkpoint: structuredClone(packet.checkpoint), totalSteps: packet.program.instructions.length,
        stepIndex: packet.checkpoint.stepIndex, currentValueHex: packet.checkpoint.stateHex,
        ownerPeerId: packet.ownerPeerId, status: verification.complete ? 'completed' : 'running',
        resultAddressHex: null, verified: true, verification: 'replayed', updatedAtMs: Date.now(), sourceTag };
      this.jobs.set(packet.jobId, job);
      this.onJobUpdate(job);
      return true;
    } catch (error) {
      this.onJobUpdate({ type: 'checkpoint_refused', code: error.code || 'invalid-checkpoint' });
      return false;
    }
  }

  async startOrResumeJob({ jobId = 'job-' + crypto.randomUUID(), totalSteps = 12,
    initialValue = 104729n, stepDelayMs = 700, program = null } = {}) {
    identifier(jobId); natural(totalSteps, MAX_PROGRAM_STEPS); natural(stepDelayMs, 60000);
    if (this.running.has(jobId)) return this.running.get(jobId);
    const work = this.runJob({ jobId, totalSteps, initialValue, stepDelayMs, program });
    this.running.set(jobId, work);
    try { return await work; } finally { this.running.delete(jobId); }
  }

  async runJob({ jobId, totalSteps, initialValue, stepDelayMs, program }) {
    const existing = this.jobs.get(jobId);
    if (!existing && this.jobs.size >= this.maxJobs) refuse('job-capacity');
    program = structuredClone(existing?.program ?? program ?? demoProgram(totalSteps, initialValue));
    await identifyProgram(program);
    let checkpoint = existing?.checkpoint ?? null;
    let step = checkpoint?.stepIndex ?? 0;
    if (checkpoint) await verifyCheckpoint(program, checkpoint, undefined, { admission: this.admission });
    // Empty jobs have a valid initial/final state and still emit a replayable checkpoint.
    do {
      if (step < program.instructions.length) step++;
      else if (checkpoint !== null) break;
      checkpoint = await createCheckpoint(program, step, checkpoint, { admission: this.admission });
      const packet = { type: 'compute_ckpt', jobId, program, checkpoint, ownerPeerId: await this.ownerIdentity() };
      if (!await this.ingestCheckpoint(packet, `local:${this.transport.peerId}`)) {
        const head = this.jobs.get(jobId);
        if (!head || head.checkpoint.jobId !== checkpoint.jobId || head.stepIndex < step) refuse('checkpoint-refused');
        checkpoint = head.checkpoint; step = head.stepIndex;
        // An independently accepted newer head wins. Never publish our refused state.
        continue;
      }
      if (this.transport.admission !== this.admission) reserveNetwork(this.admission, 'checkpoint', packet, (this.transport.openPeers?.() || []).length);
      this.transport.broadcast(packet);
      // Explicit public-data opt-in. A relay is storage with an external retention policy.
      if (this.allowPublicRelay && (step % 3 === 0 || step === program.instructions.length)) {
        if (this.transport.admission !== this.admission) reserveNetwork(this.admission, 'checkpoint', { ...packet, from: this.transport.peerId, tsMs: Date.now() });
        await this.transport.publishWarmEnvelope(packet, { publicData: true, consentCurrent: () => this.allowPublicRelay });
      }
      if (step < program.instructions.length && stepDelayMs > 0) await new Promise(r => setTimeout(r, stepDelayMs));
    } while (step < program.instructions.length);
    const job = this.jobs.get(jobId);
    if (job?.status === 'completed') {
      const stored = await this.liveDb.put(JSON.stringify({ jobId, program, checkpoint }),
        { label: `job_${jobId}_result.json`, persistWarm: this.allowPublicRelay, publicData: this.allowPublicRelay });
      job.resultAddressHex = stored.addressHex;
      this.onJobUpdate(job);
    }
    return job;
  }

  async syncAndTakeOverJobs(sinceWindow = '30m') {
    if (this.allowPublicRelay) {
      if (this.transport.admission !== this.admission) this.admission.reserve('retrieve', { requests: 1, transferBytes: 2 * 1024 * 1024 });
      const envelopes = await this.transport.fetchWarmEnvelopes(sinceWindow, { publicData: true, consentCurrent: () => this.allowPublicRelay });
      if (!Array.isArray(envelopes) || envelopes.length > this.maxJobs * 4) refuse('job-capacity');
      for (const env of envelopes) {
        if (env?.type !== 'compute_ckpt') continue;
        // Transport delivery metadata is not authority or signed program state.
        try {
          const packet = snapshotRecord(env);
          if (Object.hasOwn(packet, 'from') || Object.hasOwn(packet, 'tsMs')) {
            identifier(packet.from); natural(packet.tsMs);
            delete packet.from; delete packet.tsMs;
          }
          await this.ingestCheckpoint(packet, 'warm-relay');
        } catch { this.onJobUpdate({ type: 'checkpoint_refused', code: 'invalid-checkpoint' }); }
      }
    }
    const ownIdentity = await this.ownerIdentity();
    const active = new Set(this.transport.openPeers().map(p => p.remoteId));
    const resumed = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.ownerPeerId !== ownIdentity && !active.has(job.ownerPeerId)) {
        resumed.push(job.jobId);
        // Reachability loss is an observation, not proof of death or exclusive ownership.
        this.startOrResumeJob({ jobId: job.jobId, stepDelayMs: 0 }).catch(error =>
          this.onJobUpdate({ type: 'job_refused', code: error.code || 'host-effect-failed' }));
      }
    }
    return resumed;
  }
}
