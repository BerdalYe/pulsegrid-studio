import { useEffect, useRef, useState } from "react";

import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { renderAudio } from "../files/actions";
import { getPlaybackLengthSteps, sanitizeFilename, secondsPerStep } from "../lib/utils";
import { getProjectData } from "../state/serialize";

interface ExportDialogProps {
  onClose: () => void;
  onStatus: (message: string) => void;
}

export function ExportDialog({ onClose, onStatus }: ExportDialogProps) {
  const projectName = useProjectStore((state) => state.projectName);
  const selectedPatternId = useSessionStore((state) => state.selectedPatternId);

  const [format, setFormat] = useState<"wav" | "mp3">("wav");
  const [filename, setFilename] = useState(() => sanitizeFilename(projectName, "pulsegrid"));
  const [bitrate, setBitrate] = useState(192);
  const [range, setRange] = useState<"song" | "pattern">("song");
  const [tailSeconds, setTailSeconds] = useState(2);
  const [progress, setProgress] = useState<{ value: number; stage: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancelled = useRef(false);
  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  const project = getProjectData(useProjectStore.getState());
  const steps = getPlaybackLengthSteps(project, range, selectedPatternId);
  const seconds = steps * secondsPerStep(project.bpm) + tailSeconds;

  const busy = progress !== null;

  async function run() {
    setError(null);
    setProgress({ value: 0, stage: "Preparing" });

    try {
      const message = await renderAudio(
        { format, filename, bitrate, range, tailSeconds, selectedPatternId },
        (value, stage) => {
          if (!cancelled.current) setProgress({ value, stage });
        }
      );

      if (cancelled.current) return;
      onStatus(message);
      onClose();
    } catch (caught) {
      if (cancelled.current) return;
      console.error(caught);
      setError(caught instanceof Error ? caught.message : "Export failed.");
      setProgress(null);
    }
  }

  return (
    <div className="export-dialog-backdrop" onPointerDown={() => !busy && onClose()}>
      <div
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Export audio"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="export-dialog-title">Export audio</div>

        <label>
          File name
          <input
            value={filename}
            disabled={busy}
            onChange={(event) => setFilename(event.target.value)}
            placeholder="pulsegrid"
          />
        </label>

        <label>
          Format
          <select
            value={format}
            disabled={busy}
            onChange={(event) => setFormat(event.target.value as "wav" | "mp3")}
          >
            <option value="wav">WAV — 16-bit PCM</option>
            <option value="mp3">MP3</option>
          </select>
        </label>

        {format === "mp3" ? (
          <label>
            Bitrate
            <select
              value={bitrate}
              disabled={busy}
              onChange={(event) => setBitrate(Number(event.target.value))}
            >
              {[128, 192, 256, 320].map((rate) => (
                <option key={rate} value={rate}>
                  {rate} kbps
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label>
          Range
          <select
            value={range}
            disabled={busy}
            onChange={(event) => setRange(event.target.value as "song" | "pattern")}
          >
            <option value="song">Full arrangement</option>
            <option value="pattern">Selected pattern only</option>
          </select>
        </label>

        <label>
          Tail
          <select
            value={tailSeconds}
            disabled={busy}
            onChange={(event) => setTailSeconds(Number(event.target.value))}
          >
            <option value={0.5}>0.5 s</option>
            <option value={2}>2 s</option>
            <option value={4}>4 s</option>
            <option value={8}>8 s</option>
          </select>
        </label>

        <span className="small-note">
          {steps} steps · about {seconds.toFixed(1)} s at {Math.round(project.bpm)} BPM
        </span>

        {progress ? (
          <div className="export-progress">
            <div className="export-progress-bar">
              <span style={{ width: `${Math.min(100, progress.value)}%` }} />
            </div>
            <span className="small-note">
              {progress.stage}… {Math.round(progress.value)}%
            </span>
          </div>
        ) : null}

        {error ? <span className="export-error">{error}</span> : null}

        <div className="export-dialog-actions">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="active" onClick={() => void run()} disabled={busy}>
            {busy ? "Rendering…" : `Export ${format.toUpperCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
