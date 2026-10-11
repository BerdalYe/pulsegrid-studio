import { useEffect, useRef, useState } from "react";

import { getDropouts, getMasterPeaks, getMasterWave, getVoiceCount } from "../audio/engine";
import { getDesktop } from "../files/desktop";

/**
 * The master monitor in the top bar, as in FL Studio: an oscilloscope of what is coming out, a stereo peak meter
 * with a clip light, and a performance box with CPU load, its recent history, memory in use and how many notes
 * (voices) are sounding.
 */

/** −48 dB at the left of the meter, 0 dB (full scale) at the right. */
const FLOOR_DB = -48;
const HISTORY = 48;

/** Where a level sits on the meter, 0..1. */
export function meterPosition(level: number): number {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

function themeColour(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Size a canvas's drawing surface to its CSS size, sharp on high-density screens. */
function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

/* ─────────────────────────────── scope and meter ─────────────────────────────── */

function MasterScopeAndMeter() {
  const scope = useRef<HTMLCanvasElement | null>(null);
  const meter = useRef<HTMLCanvasElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const clippedRef = useRef(false);

  useEffect(() => {
    let frame = 0;
    let last = 0;
    const holds = [{ level: 0, at: 0 }, { level: 0, at: 0 }];

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      // About 40 frames a second is plenty for a meter, and leaves the rest for the music.
      if (document.hidden || now - last < 24) return;
      last = now;

      const accent = themeColour("--accent", "#8b5cf6");
      const accent2 = themeColour("--accent-2", "#c4b5fd");

      // ── oscilloscope ──
      const scopeCanvas = scope.current;
      const sc = scopeCanvas ? fit(scopeCanvas) : null;
      if (scopeCanvas && sc) {
        const w = scopeCanvas.clientWidth;
        const h = scopeCanvas.clientHeight;
        sc.clearRect(0, 0, w, h);
        sc.strokeStyle = "rgba(255,255,255,0.08)";
        sc.lineWidth = 1;
        sc.beginPath();
        sc.moveTo(0, h / 2 + 0.5);
        sc.lineTo(w, h / 2 + 0.5);
        sc.stroke();

        const wave = getMasterWave();
        if (wave) {
          // Start on a rising zero crossing, so a steady note stands still instead of shimmering.
          let start = 0;
          for (let i = 1; i < wave.length / 2; i++) {
            if (wave[i - 1] < 0 && wave[i] >= 0) {
              start = i;
              break;
            }
          }
          const span = Math.min(wave.length - start, 512);
          sc.strokeStyle = accent2;
          sc.lineWidth = 1.2;
          sc.shadowColor = accent;
          sc.shadowBlur = 4;
          sc.beginPath();
          for (let i = 0; i < span; i++) {
            const x = (i / (span - 1)) * w;
            const y = h / 2 - Math.max(-1, Math.min(1, wave[start + i])) * (h / 2 - 2);
            if (i === 0) sc.moveTo(x, y);
            else sc.lineTo(x, y);
          }
          sc.stroke();
          sc.shadowBlur = 0;
        }
      }

      // ── peak meter: left on top, right below ──
      const meterCanvas = meter.current;
      const mc = meterCanvas ? fit(meterCanvas) : null;
      if (meterCanvas && mc) {
        const w = meterCanvas.clientWidth;
        const h = meterCanvas.clientHeight;
        const peaks = getMasterPeaks();
        mc.clearRect(0, 0, w, h);

        const barHeight = Math.max(3, Math.floor((h - 9) / 2));
        const gradient = mc.createLinearGradient(0, 0, w, 0);
        gradient.addColorStop(0, "#2fbf71");
        gradient.addColorStop(0.7, "#e8d44d");
        gradient.addColorStop(0.9, "#f39c3d");
        gradient.addColorStop(1, "#ef4444");

        peaks.forEach((peak, side) => {
          const y = side === 0 ? 1 : 2 + barHeight;
          const position = meterPosition(peak);
          mc.fillStyle = "rgba(255,255,255,0.06)";
          mc.fillRect(0, y, w, barHeight);
          mc.fillStyle = gradient;
          mc.fillRect(0, y, position * w, barHeight);

          // The peak hold: stays a second, then falls.
          const hold = holds[side];
          if (position >= hold.level) {
            hold.level = position;
            hold.at = now;
          } else if (now - hold.at > 1000) {
            hold.level = Math.max(position, hold.level - 0.012);
          }
          if (hold.level > 0.01) {
            mc.fillStyle = hold.level >= 1 ? "#ef4444" : "#ffffff";
            mc.fillRect(Math.min(w - 2, hold.level * w), y, 2, barHeight);
          }

          if (peak > 1 && !clippedRef.current) {
            clippedRef.current = true;
            setClipped(true);
          }
        });

        // dB marks under the bars: −24, −12, −6, −3 and 0.
        mc.fillStyle = "rgba(255,255,255,0.35)";
        for (const db of [-24, -12, -6, -3, 0]) {
          const x = Math.min(w - 1, ((db - FLOOR_DB) / -FLOOR_DB) * w);
          mc.fillRect(x, 3 + barHeight * 2, 1, 3);
        }
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="fl-panel fl-panel-monitor" title="Master output: what is coming out of the speakers">
      <canvas ref={scope} className="fl-scope" aria-label="Oscilloscope of the master output" role="img" />
      <div className="fl-meter-wrap">
        <canvas ref={meter} className="fl-meter" aria-label="Peak meter of the master output" role="img" />
        <span className="fl-meter-scale" aria-hidden="true">
          <span>L</span>
          <span>R</span>
        </span>
      </div>
      <button
        type="button"
        className={`fl-clip${clipped ? " on" : ""}`}
        title={clipped ? "The master clipped (went past 0 dB). Click to reset." : "Lights up if the master goes past 0 dB"}
        aria-label={clipped ? "Master clipped. Reset" : "Clip light"}
        onClick={() => {
          clippedRef.current = false;
          setClipped(false);
        }}
      />
    </div>
  );
}

/* ─────────────────────────────── performance ─────────────────────────────── */

interface Perf {
  cpu: number | null;
  memoryMB: number | null;
  voices: number;
  dropouts: number;
}

/** In the browser there is no CPU reading: estimate how busy the page is from long tasks instead. */
function pageLoadMeter(): { take: (intervalMs: number) => number | null; stop: () => void } {
  let busy = 0;
  let supported = false;
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) busy += entry.duration;
    });
    observer.observe({ type: "longtask", buffered: false });
    supported = true;
  } catch {
    supported = false;
  }
  return {
    take: (intervalMs) => {
      if (!supported) return null;
      const share = Math.min(100, (busy / intervalMs) * 100);
      busy = 0;
      return share;
    },
    stop: () => observer?.disconnect()
  };
}

function PerformanceBox() {
  const [perf, setPerf] = useState<Perf>({ cpu: null, memoryMB: null, voices: 0, dropouts: 0 });
  const history = useRef<number[]>([]);
  const graph = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const desktop = getDesktop();
    const page = desktop?.getMetrics ? null : pageLoadMeter();
    const INTERVAL = 500;
    let alive = true;

    const tick = async () => {
      let cpu: number | null = null;
      let memoryMB: number | null = null;
      if (desktop?.getMetrics) {
        try {
          const metrics = await desktop.getMetrics();
          cpu = metrics.cpu;
          memoryMB = metrics.memoryMB;
        } catch {
          /* no reading this time */
        }
      } else {
        cpu = page?.take(INTERVAL) ?? null;
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        memoryMB = memory ? Math.round(memory.usedJSHeapSize / 1048576) : null;
      }
      if (!alive) return;

      history.current = [...history.current, cpu ?? 0].slice(-HISTORY);
      setPerf({ cpu, memoryMB, voices: getVoiceCount(), dropouts: getDropouts() });

      // The load history: a bar for each half second, newest on the right.
      const canvas = graph.current;
      const g = canvas ? fit(canvas) : null;
      if (canvas && g) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        g.clearRect(0, 0, w, h);
        const barWidth = w / HISTORY;
        const values = history.current;
        // Scaled to what has happened lately (at least 0–20%), so ordinary loads still show as a shape.
        const top = Math.max(20, ...values.map((value) => value * 1.25));
        values.forEach((value, index) => {
          const x = w - (values.length - index) * barWidth;
          const height = Math.max(1, (Math.min(top, value) / top) * (h - 1));
          g.fillStyle = value > 80 ? "#ef4444" : value > 50 ? "#e8d44d" : themeColour("--accent", "#8b5cf6");
          g.globalAlpha = 0.35 + 0.65 * ((index + 1) / values.length);
          g.fillRect(x, h - height, Math.max(1, barWidth - 0.5), height);
        });
        g.globalAlpha = 1;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), INTERVAL);
    return () => {
      alive = false;
      window.clearInterval(timer);
      page?.stop();
    };
  }, []);

  const cpu = perf.cpu === null ? "—" : `${Math.round(perf.cpu)}%`;
  const memory = perf.memoryMB === null ? "—" : `${perf.memoryMB} MB`;

  return (
    <div
      className="fl-panel fl-panel-perf"
      title={
        getDesktop()
          ? `CPU: the processing power PulseGrid Studio is using, as a share of one core (100% is one core fully busy), with the last 24 seconds behind it. Memory: what the app is using. Voices: notes sounding right now.${perf.dropouts > 0 ? ` Dropouts: the sound broke up ${perf.dropouts} time${perf.dropouts === 1 ? "" : "s"}; a safer latency under Settings → Audio can help.` : ""}`
          : "CPU: how busy this page is, with the last 24 seconds behind it. Memory: what the page is using, where the browser can tell. Voices: notes sounding right now."
      }
    >
      <div className="fl-perf-load">
        <canvas ref={graph} className="fl-perf-graph" aria-hidden="true" />
        <span className="fl-perf-cpu">
          <em>CPU</em>
          {cpu}
        </span>
      </div>
      <div className="fl-perf-figures">
        <span>
          <strong>{perf.voices}</strong>
          <em>voices</em>
        </span>
        <span>
          <strong>{memory}</strong>
        </span>
        {perf.dropouts > 0 ? (
          <span className="fl-perf-drops">
            <strong>{perf.dropouts}</strong>
            <em>drops</em>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The whole monitor: scope and meter, then the performance box. */
export function HeaderMonitor() {
  return (
    <>
      <MasterScopeAndMeter />
      <PerformanceBox />
    </>
  );
}
