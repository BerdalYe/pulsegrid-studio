import { registerSample, type RegisteredSample } from "./sampleRegistry";
import { uid } from "../lib/utils";

const createFloatBuffer = (length: number) => new Float32Array(length);

/** Microphone / line-in capture, turned into a sample when you stop. */
class AudioRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frame: number | null = null;
  private meterData: ReturnType<typeof createFloatBuffer> | null = null;

  private readonly meterListeners = new Set<(level: number) => void>();

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  onLevel(listener: (level: number) => void): () => void {
    this.meterListeners.add(listener);
    return () => {
      this.meterListeners.delete(listener);
    };
  }

  async start(context: AudioContext): Promise<void> {
    if (this.isRecording) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone input isn't supported in this browser.");
    }

    if (typeof MediaRecorder === "undefined") {
      throw new Error("Recording isn't supported in this browser.");
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    this.source = context.createMediaStreamSource(this.stream);
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.meterData = createFloatBuffer(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.startMeter();

    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    this.recorder.start(200);
  }

  async stop(context: BaseAudioContext): Promise<RegisteredSample | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== "recording") {
      this.teardown();
      return null;
    }

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      recorder.stop();
    });

    this.teardown();

    if (blob.size < 256) return null;

    try {
      const bytes = await blob.arrayBuffer();
      const decoded = await context.decodeAudioData(bytes.slice(0));
      const name = `Recording ${new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })}`;

      return registerSample(uid(), decoded, name, { source: blob });
    } catch (error) {
      console.error("Could not decode the recording:", error);
      return null;
    }
  }

  /** Abandon a recording without keeping the audio. */
  cancel(): void {
    if (this.recorder?.state === "recording") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.teardown();
  }

  private teardown(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }

    this.source?.disconnect();
    this.analyser?.disconnect();
    this.source = null;
    this.analyser = null;
    this.meterData = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    this.recorder = null;
    this.chunks = [];

    for (const listener of this.meterListeners) listener(0);
  }

  private startMeter(): void {
    const tick = () => {
      const analyser = this.analyser;
      const data = this.meterData;

      if (!analyser || !data) {
        this.frame = null;
        return;
      }

      analyser.getFloatTimeDomainData(data);

      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const level = Math.min(1, Math.sqrt(sum / data.length) * 3);

      for (const listener of this.meterListeners) listener(level);
      this.frame = requestAnimationFrame(tick);
    };

    this.frame = requestAnimationFrame(tick);
  }
}

export const audioRecorder = new AudioRecorder();
