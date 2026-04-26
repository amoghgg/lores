export type AudioState =
  | "empty"
  | "loading"
  | "loaded"
  | "playing"
  | "paused"
  | "mic"
  | "error";

export type AudioFrame = {
  bass: number;
  mid: number;
  treble: number;
  beat: number;
  time: number;
  duration: number;
  /** First 256 frequency bins, each 0..1. Top half of FFT discarded. */
  fft: Float32Array;
};

const FFT_SIZE = 1024;
const FFT_BIN_COUNT_FOR_VIZ = 256;

const BASS_END = 5; // ~115 Hz
const MID_END = 42; // ~970 Hz

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private destinationConnected = false;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private pausedAt = 0;
  private loopFlag = false;

  private mediaStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;

  state: AudioState = "empty";
  filename = "";
  duration = 0;
  errorMessage = "";

  private freqBuf = new Uint8Array(FFT_SIZE / 2);
  private fftFloat = new Float32Array(FFT_BIN_COUNT_FOR_VIZ);

  private energyHistory: number[] = [];
  private beatPulse = 0;
  private lastBeatAt = 0;

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
    // analyser → gain stays wired; gain → destination is conditional
    this.analyser.connect(this.gain);
  }

  private connectToDestination() {
    if (!this.ctx || !this.gain) return;
    if (this.destinationConnected) return;
    this.gain.connect(this.ctx.destination);
    this.destinationConnected = true;
  }

  private disconnectFromDestination() {
    if (!this.gain || !this.destinationConnected) return;
    try {
      this.gain.disconnect(this.ctx!.destination);
    } catch {}
    this.destinationConnected = false;
  }

  // ─── FILE PATH ───────────────────────────────────────────────────────

  async loadFile(file: File) {
    this.ensureContext();
    if (!this.ctx) return;
    try {
      this.state = "loading";
      this.emit();
      this.stopMic();
      this.stop();
      const arrayBuffer = await file.arrayBuffer();
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
      this.errorMessage = (err as Error).message;
      this.emit();
    }
  }

  async play() {
    if (!this.ctx || !this.buffer || !this.analyser) return;
    if (this.state === "playing") return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.connectToDestination();
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.loop = this.loopFlag;
    this.source.connect(this.analyser);
    this.source.start(0, this.pausedAt);
    this.startedAt = this.ctx.currentTime - this.pausedAt;
    this.source.onended = () => {
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
    if (this.state === "mic") return;
    this.state = this.buffer ? "loaded" : "empty";
    this.emit();
  }

  toggle() {
    if (this.state === "playing") this.pause();
    else void this.play();
  }

  /** Seek to a time in seconds. If currently playing, seamlessly continues. */
  async seek(t: number) {
    if (!this.buffer) return;
    const target = Math.max(0, Math.min(t, this.duration - 0.05));
    const wasPlaying = this.state === "playing";
    if (wasPlaying && this.ctx && this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {}
      this.source = null;
    }
    this.pausedAt = target;
    if (wasPlaying) await this.play();
    else this.emit();
  }

  setLoop(loop: boolean) {
    this.loopFlag = loop;
    if (this.source) this.source.loop = loop;
    this.emit();
  }

  get loop(): boolean {
    return this.loopFlag;
  }

  getCurrentTime(): number {
    if (!this.ctx) return 0;
    if (this.state === "playing") {
      const t = this.ctx.currentTime - this.startedAt;
      // Wrap with loop
      if (this.loopFlag && this.duration > 0) {
        return t % this.duration;
      }
      return Math.min(t, this.duration);
    }
    return this.pausedAt;
  }

  // ─── MIC PATH ────────────────────────────────────────────────────────

  async startMic() {
    this.ensureContext();
    if (!this.ctx || !this.analyser) return;
    this.stop(); // stop any file playback
    if (this.ctx.state === "suspended") await this.ctx.resume();
    try {
      // Disconnect from speakers BEFORE wiring mic — prevents feedback
      this.disconnectFromDestination();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.mediaStream = stream;
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.analyser);
      this.energyHistory = [];
      this.state = "mic";
      this.emit();
    } catch (err) {
      console.error("[lores] mic permission failed:", err);
      this.state = "error";
      this.errorMessage =
        (err as Error).name === "NotAllowedError"
          ? "Mic permission denied"
          : (err as Error).message;
      this.emit();
    }
  }

  stopMic() {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {}
      this.micSource = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.state === "mic") {
      this.state = this.buffer ? "loaded" : "empty";
      this.emit();
    }
  }

  // ─── SAMPLING ────────────────────────────────────────────────────────

  sample(): AudioFrame {
    if (!this.analyser || !this.ctx) {
      this.fftFloat.fill(0);
      return {
        bass: 0,
        mid: 0,
        treble: 0,
        beat: 0,
        time: 0,
        duration: this.duration,
        fft: this.fftFloat,
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

    // Pack first 256 bins as floats for the GPU (covers ~0–12 kHz)
    for (let i = 0; i < FFT_BIN_COUNT_FOR_VIZ; i++) {
      this.fftFloat[i] = bins[i] / 255;
    }

    this.energyHistory.push(bass);
    if (this.energyHistory.length > 43) this.energyHistory.shift();
    let avg = 0;
    for (const e of this.energyHistory) avg += e;
    avg /= Math.max(1, this.energyHistory.length);

    const now = this.ctx.currentTime;
    if (bass > avg * 1.4 && bass > 0.28 && now - this.lastBeatAt > 0.18) {
      this.beatPulse = 1;
      this.lastBeatAt = now;
    } else {
      this.beatPulse *= 0.86;
    }

    const time =
      this.state === "playing" ? this.getCurrentTime() : this.pausedAt;

    return {
      bass,
      mid,
      treble,
      beat: this.beatPulse,
      time,
      duration: this.duration,
      fft: this.fftFloat,
    };
  }

  dispose() {
    this.stop();
    this.stopMic();
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
