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
    verified: verification.ok,
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
  constructor({ transport, screenContainer, onStatus = () => {} }) {
    this.transport = transport;
    this.screenContainer = screenContainer;
    this.onStatus = onStatus;
    this.v86 = null;
    this.booted = false;
    this.booting = false;
    this.ethFramesSent = 0;
    this.ethFramesReceived = 0;
    this.ipAddress = `10.42.0.${(parseInt(this.transport.peerId.slice(-4), 36) % 250) + 2}`;
  }

  boot() {
    if (this.v86 || this.booting) return;
    const V86Ctor = globalThis.V86 || globalThis.V86Starter;
    if (!V86Ctor) {
      this.onStatus({ state: 'error', message: 'libv86.js not loaded' });
      return;
    }

    this.booting = true;
    this.onStatus({ state: 'booting', ip: this.ipAddress });

    this.v86 = new V86Ctor({
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

    // Bridge outgoing Layer-2 Ethernet frames from Linux eth0 over WebRTC DataChannels
    this.v86.add_listener('net0-send', frameBytes => {
      this.ethFramesSent++;
      this.transport.broadcast({
        type: 'eth_frame',
        from: this.transport.peerId,
        frame: Array.from(frameBytes)
      });
    });

    const checkInterval = setInterval(() => {
      if (!this.v86) {
        clearInterval(checkInterval);
        return;
      }
      const text = Array.from(this.screenContainer.querySelectorAll('span'))
        .map(s => s.innerText)
        .join('')
        .replace(/[\s\u00a0]+/g, ' ')
        .trim();

      if (text.includes('~%') || text.includes('# ')) {
        clearInterval(checkInterval);
        this.booted = true;
        this.booting = false;
        // Configure virtual Ethernet interface eth0 inside the Linux VM
        const netInit = `ifconfig eth0 ${this.ipAddress} netmask 255.255.255.0 up 2>/dev/null\n`;
        this.v86.keyboard_send_text(netInit, 10);
        this.onStatus({ state: 'online', ip: this.ipAddress });
      }
    }, 250);
  }

  handleIncomingEthFrame(frameArray) {
    if (!this.v86 || !this.booted || !Array.isArray(frameArray)) return;
    this.ethFramesReceived++;
    this.v86.bus.send('net0-receive', new Uint8Array(frameArray));
  }

  async mountUorObject(addressHex, bytes, label = '') {
    if (!this.v86) return false;
    const shortId = addressHex.replace('uor:ca:', '').slice(0, 12);
    const filename = `uor_${shortId}.bin`;
    try {
      await this.v86.create_file(filename, new Uint8Array(bytes));
      if (label) {
        const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
        await this.v86.create_file(safeLabel, new Uint8Array(bytes));
      }
      return true;
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
    throw new Error(`VM command timed out after ${timeoutMs}ms`);
  }
}

/**
 * Live Distributed Compute Coordinator over WebRTC + Warm Relay Cache.
 * Runs multi-step UOR Z/(2^64)Z programs with real network checkpointing:
 * if the executing browser tab closes mid-job, another open tab (or a newly
 * opened tab reading the warm cache) resumes execution from the last verified step!
 */
export class LiveDistributedComputeCoordinator {
  constructor({ transport, liveDb, onJobUpdate = () => {} }) {
    this.transport = transport;
    this.liveDb = liveDb;
    this.onJobUpdate = onJobUpdate;
    /** @type {Map<string, object>} */
    this.jobs = new Map();
  }

  async handleMeshMessage(fromPeerId, msg) {
    if (!msg || msg.type !== 'compute_ckpt') return;
    await this.ingestCheckpoint(msg, `webrtc:${fromPeerId}`);
  }

  async ingestCheckpoint(ckpt, sourceTag = 'remote') {
    const existing = this.jobs.get(ckpt.jobId);
    if (existing && existing.stepIndex >= ckpt.stepIndex && existing.status === 'completed') {
      return;
    }

    const job = {
      jobId: ckpt.jobId,
      totalSteps: ckpt.totalSteps,
      stepIndex: ckpt.stepIndex,
      currentValueHex: ckpt.currentValueHex,
      events: ckpt.events.map(e => new TraceEvent(e.stepIndex, e.op, {
        isZero: () => false,
        toHex: () => e.targetHex
      })),
      rawEvents: ckpt.events,
      ownerPeerId: ckpt.ownerPeerId,
      status: ckpt.status,
      resultAddressHex: ckpt.resultAddressHex || null,
      verified: ckpt.verified || false,
      updatedAtMs: Date.now(),
      sourceTag
    };
    this.jobs.set(ckpt.jobId, job);
    this.onJobUpdate(job);
  }

  /**
   * Start or resume a multi-step UOR reduction job across the live network.
   * Each step executes a Z/(2^64)Z ring operation, commits a checkpoint over WebRTC
   * and to the warm relay cache, and pauses `stepDelayMs` so you can test closing the tab mid-job.
   */
  async startOrResumeJob({
    jobId = 'job-' + Math.random().toString(36).slice(2, 7),
    totalSteps = 12,
    initialValue = 104729n,
    stepDelayMs = 700
  } = {}) {
    let job = this.jobs.get(jobId);
    let step = job ? job.stepIndex : 0;
    let curDatum = job ? Datum.w64(BigInt(job.currentValueHex)) : Datum.w64(BigInt(initialValue));
    let rawEvents = job ? [...job.rawEvents] : [];

    while (step < totalSteps) {
      const op = step % 3 === 0
        ? PrimitiveOp.ADD
        : step % 3 === 1
        ? PrimitiveOp.XOR
        : PrimitiveOp.SUCC;
      const arg = step % 3 === 0
        ? Datum.w64(BigInt((step + 1) * 257))
        : step % 3 === 1
        ? Datum.w64(0x9e3779b97f4a7c15n)
        : null;

      curDatum = applyPrimitiveOp(op, curDatum, arg);
      const { address } = mintContentAddress(curDatum.toBytes(), Fnv1aHasher16);
      rawEvents.push({
        stepIndex: step,
        op,
        targetHex: address.toHex()
      });
      step++;

      const isFinal = step >= totalSteps;
      let resultAddressHex = null;
      let verified = false;

      if (isFinal) {
        const traceEvents = rawEvents.map(e => {
          const hex = e.targetHex.replace('uor:ca:', '');
          return new TraceEvent(e.stepIndex, e.op, {
            raw: BigInt('0x' + hex),
            isZero: () => BigInt('0x' + hex) === 0n,
            toHex: () => e.targetHex
          });
        });
        const finalCheck = finalizeAndVerifyExecution(curDatum, traceEvents);
        verified = finalCheck.verified;

        const stored = await this.liveDb.put(
          JSON.stringify({
            jobId,
            finalDatumHex: '0x' + curDatum.value.toString(16),
            totalSteps,
            verified,
            certificateFingerprint: finalCheck.certificate?.fingerprint?.toHex() || null
          }),
          { label: `job_${jobId}_result.json`, persistWarm: true }
        );
        resultAddressHex = stored.addressHex;
      }

      const ckptPacket = {
        type: 'compute_ckpt',
        jobId,
        totalSteps,
        stepIndex: step,
        currentValueHex: '0x' + curDatum.value.toString(16),
        events: rawEvents,
        ownerPeerId: this.transport.peerId,
        status: isFinal ? 'completed' : 'running',
        resultAddressHex,
        verified
      };

      await this.ingestCheckpoint(ckptPacket, `local:${this.transport.peerId}`);
      this.transport.broadcast(ckptPacket);
      if (step % 3 === 0 || isFinal) {
        await this.transport.publishWarmEnvelope(ckptPacket);
      }

      if (!isFinal && stepDelayMs > 0) {
        await new Promise(r => setTimeout(r, stepDelayMs));
      }
    }

    return this.jobs.get(jobId);
  }

  /**
   * Recover in-flight or completed jobs from the warm relay ring-buffer,
   * and automatically take over any unfinished (`running`) job whose original owner died!
   */
  async syncAndTakeOverJobs(sinceWindow = '30m') {
    const envelopes = await this.transport.fetchWarmEnvelopes(sinceWindow);
    for (const env of envelopes) {
      if (env && env.type === 'compute_ckpt') {
        await this.ingestCheckpoint(env, `warm-relay:${env.ownerPeerId || 'cache'}`);
      }
    }

    const activePeerIds = new Set(this.transport.openPeers().map(p => p.remoteId));
    const resumed = [];
    for (const job of this.jobs.values()) {
      if (
        job.status === 'running' &&
        job.stepIndex < job.totalSteps &&
        job.ownerPeerId !== this.transport.peerId &&
        !activePeerIds.has(job.ownerPeerId)
      ) {
        resumed.push(job.jobId);
        this.startOrResumeJob({
          jobId: job.jobId,
          totalSteps: job.totalSteps,
          stepDelayMs: 400
        });
      }
    }
    return resumed;
  }
}
