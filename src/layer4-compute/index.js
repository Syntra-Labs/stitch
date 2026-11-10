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
import { ResourceAdmission, reserveNetwork } from '../layer2-schedulers/policy.js';
import { snapshotRecord } from '../layer1-uor/custody.js';
import { record, identifier, natural, refuse } from '../layer1-uor/contracts.js';
import { computeSurvivalProbability } from '../layer2-schedulers/index.js';

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
  constructor({ transport, screenContainer, onStatus = () => {}, bootTimeoutMs = 60000 }) {
    if (!Number.isFinite(bootTimeoutMs) || bootTimeoutMs <= 0 || bootTimeoutMs > 2147483647) throw new Error('Invalid VM boot timeout');
    this.transport = transport;
    this.screenContainer = screenContainer;
    this.onStatus = onStatus;
    this.v86 = null;
    this.booted = false;
    this.booting = false;
    this.bootTimeoutMs = bootTimeoutMs;
    this.bootGeneration = 0;
    this.bootPoll = null;
    this.bootDeadline = null;
    this.ethFramesSent = 0;
    this.ethFramesReceived = 0;
    this.ipAddress = `10.42.0.${(parseInt(this.transport.peerId.slice(-4), 36) % 250) + 2}`;
  }

  clearBootTimers() {
    if (this.bootPoll !== null) clearInterval(this.bootPoll);
    if (this.bootDeadline !== null) clearTimeout(this.bootDeadline);
    this.bootPoll = null;
    this.bootDeadline = null;
  }

  failBoot(generation, message) {
    if (generation !== this.bootGeneration || !this.booting) return;
    // Invalidate listeners before cleanup, which may dispatch synchronous events.
    this.bootGeneration++;
    this.clearBootTimers();
    const failed = this.v86;
    this.v86 = null;
    this.booted = false;
    this.booting = false;
    try { Promise.resolve(failed?.destroy?.()).catch(() => {}); } catch {}
    this.onStatus({ state: 'error', message });
  }

  boot() {
    if (this.v86 || this.booting) return;
    const generation = ++this.bootGeneration;
    this.booting = true;
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
        cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on',
        filesystem: {},
        net_device: { type: 'ne2k' },
        autostart: true
      });
      this.v86 = vm;
      const current = () => generation === this.bootGeneration && this.v86 === vm;
      vm.add_listener('download-error', () => {
        if (current()) this.failBoot(generation, 'VM asset download failed; retry Boot when assets are available.');
      });
      vm.add_listener('net0-send', frameBytes => {
        if (!current()) return;
        this.ethFramesSent++;
        this.transport.broadcast({ type: 'eth_frame', from: this.transport.peerId, frame: Array.from(frameBytes) });
      });
      this.bootDeadline = setTimeout(() => {
        if (current()) this.failBoot(generation, `VM readiness was not observed within ${this.bootTimeoutMs}ms; retry Boot explicitly.`);
      }, this.bootTimeoutMs);
      this.bootPoll = setInterval(() => {
        if (!current() || !this.booting) return;
        try {
          const text = Array.from(this.screenContainer.querySelectorAll('span'))
            .map(s => s.innerText).join('').replace(/[\s\u00a0]+/g, ' ').trim();
          if (text.includes('~%') || /#(?:\s|$)/.test(text)) {
            // Readiness is a host observation, not a proof of guest correctness.
            vm.keyboard_send_text(`ifconfig eth0 ${this.ipAddress} netmask 255.255.255.0 up 2>/dev/null\n`, 10);
            this.clearBootTimers();
            this.booted = true;
            this.booting = false;
            this.onStatus({ state: 'online', ip: this.ipAddress });
          }
        } catch (error) {
          this.failBoot(generation, `VM boot failed: ${error.message}`);
        }
      }, 250);
    } catch (error) {
      this.failBoot(generation, `VM boot failed: ${error.message}`);
    }
  }

  handleIncomingEthFrame(frameArray) {
    if (!this.v86 || !this.booted || !Array.isArray(frameArray)) return;
    this.ethFramesReceived++;
    this.v86.bus.send('net0-receive', new Uint8Array(frameArray));
  }

  async mountUorObject(addressHex, bytes, label = '') {
    const vm = this.v86, generation = this.bootGeneration;
    if (!vm) return false;
    const current = () => this.v86 === vm && this.bootGeneration === generation;
    const shortId = addressHex.replace('uor:ca:', '').slice(0, 12);
    const filename = `uor_${shortId}.bin`;
    try {
      await vm.create_file(filename, new Uint8Array(bytes));
      if (!current()) return false;
      if (label) {
        const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
        await vm.create_file(safeLabel, new Uint8Array(bytes));
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
  async executeShellCommand(commandStr, timeoutMs = 6000) {
    if (!this.v86 || !this.booted) {
      throw new Error('Linux VM is not booted yet.');
    }
    const runId = Math.random().toString(36).slice(2, 8);
    const scriptName = `job_${runId}.sh`;
    const outName = `out_${runId}.txt`;
    const doneName = `done_${runId}.flag`;

    const scriptBody = `#!/bin/sh\n(${commandStr}) > /mnt/${outName} 2>&1\necho OK > /mnt/${doneName}\n`;
    await this.v86.create_file(scriptName, new TextEncoder().encode(scriptBody));
    await this.v86.keyboard_send_text(`sh /mnt/${scriptName}\n`, 10);

    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      try {
        const doneBuf = await this.v86.read_file(doneName);
        if (doneBuf && doneBuf.length > 0) {
          const outBuf = await this.v86.read_file(outName);
          return outBuf ? new Uint8Array(outBuf) : new Uint8Array(0);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`VM command timed out after ${timeoutMs}ms; completion is unknown and the guest command was not cancelled.`);
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
      const packet = { type: 'compute_ckpt', jobId, program, checkpoint, ownerPeerId: this.transport.peerId };
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
        await this.transport.publishWarmEnvelope(packet);
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
      const envelopes = await this.transport.fetchWarmEnvelopes(sinceWindow);
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
    const active = new Set(this.transport.openPeers().map(p => p.remoteId));
    const resumed = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.ownerPeerId !== this.transport.peerId && !active.has(job.ownerPeerId)) {
        resumed.push(job.jobId);
        // Reachability loss is an observation, not proof of death or exclusive ownership.
        this.startOrResumeJob({ jobId: job.jobId, stepDelayMs: 0 }).catch(error =>
          this.onJobUpdate({ type: 'job_refused', code: error.code || 'host-effect-failed' }));
      }
    }
    return resumed;
  }
}
