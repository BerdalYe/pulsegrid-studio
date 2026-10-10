import { ensureFontsFor } from "./soundfont/registry";
import type { ProjectData } from "../types";

import { deliverExport } from "../files/desktop";
import { RenderGraph } from "./graph";
import { Sequencer } from "./sequencer";
import { audioBufferToWavBlob } from "./wav";

import {
  applySwing,
  getPlaybackLengthSteps,
  sanitizeFilename,
  secondsPerStep
} from "../lib/utils";

export type ExportProgressCallback = (progress: number, stage: string) => void;

export interface ExportOptions {
  format: "wav" | "mp3";
  filename: string;
  bitrate: number;
  /** "song" renders the arrangement, "pattern" renders the selected pattern. */
  range: "song" | "pattern";
  selectedPatternId: string;
  /** Extra seconds of silence so reverb tails aren't clipped off. */
  tailSeconds: number;
  sampleRate: number;
}

export const defaultExportOptions: ExportOptions = {
  format: "wav",
  filename: "pulsegrid",
  bitrate: 192,
  range: "song",
  selectedPatternId: "",
  tailSeconds: 2,
  sampleRate: 44100
};

/**
 * Render the project to an audio file.
 *
 * The whole render happens on an OfflineAudioContext with its own graph — no
 * node from the live context is touched, so exporting can't disturb playback
 * and automation lands in the file exactly as it sounds.
 */
export async function renderProject(
  project: ProjectData,
  options: ExportOptions,
  onProgress?: ExportProgressCallback
): Promise<AudioBuffer> {
  // Recorded instruments must be in memory before anything is rendered with them.
  await ensureFontsFor(project.channels);

  const mode = options.range === "pattern" ? "pattern" : "song";
  const stepDuration = secondsPerStep(project.bpm);
  const totalSteps = getPlaybackLengthSteps(project, mode, options.selectedPatternId);
  const duration = totalSteps * stepDuration + Math.max(0.5, options.tailSeconds);

  const offline = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.ceil(duration * options.sampleRate),
    sampleRate: options.sampleRate
  });

  const graph = new RenderGraph(offline, project);
  const sequencer = new Sequencer(graph);
  sequencer.reset();

  const leadIn = 0.05;

  for (let step = 0; step < totalSteps; step++) {
    const baseTime = step * stepDuration + leadIn;
    const time = applySwing(baseTime, step, stepDuration, project.swing);
    sequencer.scheduleStep(
      project,
      { mode, selectedPatternId: options.selectedPatternId },
      step,
      time,
      stepDuration
    );
  }

  // OfflineAudioContext can be suspended at set points, which is the only way
  // to report render progress.
  if (onProgress) {
    const checkpoints = 20;
    for (let i = 1; i < checkpoints; i++) {
      const at = (duration * i) / checkpoints;
      void offline.suspend(at).then(() => {
        onProgress((i / checkpoints) * 65, "Rendering");
        void offline.resume();
      });
    }
  }

  onProgress?.(2, "Rendering");
  const rendered = await offline.startRendering();
  onProgress?.(70, "Encoding");

  graph.dispose();

  return rendered;
}

function encodeInWorker(
  buffer: AudioBuffer,
  options: ExportOptions,
  onProgress?: ExportProgressCallback
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let worker: Worker;

    try {
      worker = new Worker(new URL("./exportWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error);
      return;
    }

    // Copy the channel data. `getChannelData` hands back the AudioBuffer's own
    // memory, and transferring that would detach the rendered buffer.
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
      channels.push(buffer.getChannelData(c).slice());
    }

    const cleanup = () => worker.terminate();

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | { type: "progress"; progress: number }
        | { type: "done"; buffer: ArrayBuffer }
        | { type: "error"; message: string };

      if (message.type === "progress") {
        onProgress?.(70 + message.progress * 0.3, "Encoding");
        return;
      }

      if (message.type === "error") {
        cleanup();
        reject(new Error(message.message));
        return;
      }

      const blob = new Blob([message.buffer], {
        type: options.format === "mp3" ? "audio/mpeg" : "audio/wav"
      });

      cleanup();
      resolve(blob);
    };

    worker.onerror = (error) => {
      cleanup();
      reject(error instanceof ErrorEvent ? new Error(error.message) : error);
    };

    worker.postMessage(
      {
        format: options.format,
        channels,
        sampleRate: buffer.sampleRate,
        length: buffer.length,
        bitrate: options.bitrate
      },
      channels.map((channel) => channel.buffer)
    );
  });
}

export async function exportProject(
  project: ProjectData,
  options: Partial<ExportOptions>,
  onProgress?: ExportProgressCallback
): Promise<string | null> {
  const resolved: ExportOptions = { ...defaultExportOptions, ...options };
  const rendered = await renderProject(project, resolved, onProgress);

  let blob: Blob;

  try {
    blob = await encodeInWorker(rendered, resolved, onProgress);
  } catch {
    // Worker unavailable (or it failed): fall back to the main thread. The
    // rendered buffer is still intact because we never transferred it.
    if (resolved.format === "mp3") throw new Error("MP3 encoding is unavailable in this browser.");
    onProgress?.(85, "Encoding");
    blob = audioBufferToWavBlob(rendered);
  }

  onProgress?.(100, "Done");

  const name = sanitizeFilename(resolved.filename, "pulsegrid");
  // Desktop: written into the Exports folder and returned; browser: downloaded.
  return deliverExport(blob, `${name}.${resolved.format}`);
}
