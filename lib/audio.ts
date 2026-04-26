export type AudioState = "empty" | "loading" | "loaded" | "playing" | "paused" | "error";

export type AudioFrame = {
  bass: number;
  mid: number;
  treble: number;
  beat: number;
  time: number;
  duration: number;
};

const FFT_SIZE = 1024;

// Frequency band boundaries (bin indices, assuming 48 kHz sample rate, 1024 fft → 23 Hz/bin)
const BASS_END = 5; // ~115 Hz
const MID_END = 42; // ~970 Hz

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  private startedAt = 0;
  private pausedAt = 0;

  state: AudioState = "empty";
  filename = "";
  duration = 0;

  private freqBuf = new Uint8Array(FFT_SIZE / 2);

  // Beat detection
  private energyHistory: number[] = [];
  private beatPulse = 0;
  private lastBeatAt = 0;

  // Notify hooks of state changes
  private listeners = new Set<() => void>();
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  private ensureContext() {
    if (this.ctx) return;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.7;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);
  }

  async loadFile(file: File) {
    this.ensureContext();
    if (!this.ctx) return;
    try {
      this.state = "loading";
      this.emit();
      this.stop();
      const arrayBuffer = await file.arrayBuffer();
      // Some browsers mutate the input buffer during decode; clone it.
      this.buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
      this.filename = file.name;
      this.duration = this.buffer.duration;
      this.state = "loaded";
      this.pausedAt = 0;
      this.energyHistory = [];
      this.emit();
    } catch (err) {
      console.error("[lores] audio decode failed:", err);
      this.state = "error";
      this.emit();
    }
  }

  async play() {
    if (!this.ctx || !this.buffer || !this.analyser) return;
    if (this.state === "playing") return;
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.analyser);
    this.source.start(0, this.pausedAt);
    this.startedAt = this.ctx.currentTime - this.pausedAt;
    this.source.onended = () => {
      // onended fires both on natural completion and stop(); guard via state
      if (this.state === "playing") {
        this.state = "loaded";
        this.pausedAt = 0;
        this.emit();
      }
    };
    this.state = "playing";
    this.emit();
  }

  pause() {
    if (this.state !== "playing" || !this.ctx || !this.source) return;
    this.pausedAt = this.ctx.currentTime - this.startedAt;
    try {
      this.source.onended = null;
      this.source.stop();
    } catch {}
    this.source = null;
    this.state = "paused";
    this.emit();
  }

  stop() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {}
      this.source = null;
    }
    this.pausedAt = 0;
    if (this.buffer) {
      this.state = "loaded";
    } else {
      this.state = "empty";
    }
    this.emit();
  }

  toggle() {
    if (this.state === "playing") this.pause();
    else this.play();
  }

  setVolume(v: number) {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Sample the analyser and update beat state. Call once per animation frame. */
  sample(): AudioFrame {
    if (!this.analyser || !this.ctx) {
      return {
        bass: 0,
        mid: 0,
        treble: 0,
        beat: 0,
        time: 0,
        duration: this.duration,
      };
    }

    this.analyser.getByteFrequencyData(this.freqBuf);
    const bins = this.freqBuf;

    let bassSum = 0;
    for (let i = 0; i < BASS_END; i++) bassSum += bins[i];
    const bass = bassSum / (BASS_END * 255);

    let midSum = 0;
    for (let i = BASS_END; i < MID_END; i++) midSum += bins[i];
    const mid = midSum / ((MID_END - BASS_END) * 255);

    let trebleSum = 0;
    for (let i = MID_END; i < bins.length; i++) trebleSum += bins[i];
    const treble = trebleSum / ((bins.length - MID_END) * 255);

    // Beat detection: bass energy spike vs. recent rolling average.
    this.energyHistory.push(bass);
    if (this.energyHistory.length > 43) this.energyHistory.shift();
    let avg = 0;
    for (const e of this.energyHistory) avg += e;
    avg /= Math.max(1, this.energyHistory.length);

    const now = this.ctx.currentTime;
    if (
      bass > avg * 1.4 &&
      bass > 0.28 &&
      now - this.lastBeatAt > 0.18
    ) {
      this.beatPulse = 1;
      this.lastBeatAt = now;
    } else {
      this.beatPulse *= 0.86;
    }

    const time =
      this.state === "playing"
        ? now - this.startedAt
        : this.pausedAt;

    return {
      bass,
      mid,
      treble,
      beat: this.beatPulse,
      time,
      duration: this.duration,
    };
  }

  dispose() {
    this.stop();
    this.buffer = null;
    this.filename = "";
    this.duration = 0;
    this.state = "empty";
    this.emit();
  }
}

let instance: AudioEngine | null = null;
export function getAudio(): AudioEngine {
  if (!instance) instance = new AudioEngine();
  return instance;
}
