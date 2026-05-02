import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  open as dialogOpen,
  save as dialogSave,
} from "@tauri-apps/plugin-dialog";

type Frame = {
  values: number[];
  net: number;
  subnet: number;
  universe: number;
};

type UniverseKey = string; // "net/subnet/universe"

type WavRecording = {
  timestamps: number[];
  channels: number[][];
  dmx_channels?: number[];
};

interface RecordPlayTabProps {}

const CHANNELS = 512;
const CELL_H = 24;
const GUTTER_W = 48;

function interpolatedSample(
  vt: readonly number[],
  vals: Uint8Array,
  t: number
): number {
  const n = vt.length;
  if (n === 0 || vals.length === 0) return 0;
  const last = n - 1;
  if (t <= vt[0]) return vals[0];
  if (t >= vt[last]) return vals[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (vt[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = vt[lo];
  const t1 = vt[hi];
  const v0 = vals[lo];
  const v1 = vals[hi];
  const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  return v0 + (v1 - v0) * u;
}

const VIZ_PREVIEW_WINDOW_MS = 30_000;
const VIZ_HOLD_LAST_MS = 500;

function trimVizBeforeTime(
  cutoffMs: number,
  channels: readonly number[],
  vizTRef: { current: number[] },
  vizBufRef: { current: Uint8Array[] }
): void {
  const vt = vizTRef.current;
  const n = vt.length;
  if (n === 0) return;
  let start = 0;
  while (start < n && vt[start] < cutoffMs) start++;
  const sliceStart = Math.max(0, start - 1);
  if (sliceStart === 0) return;
  vizTRef.current = vt.slice(sliceStart);
  for (const dmx of channels) {
    const chIdx = Math.min(Math.max(dmx - 1, 0), CHANNELS - 1);
    const buf = vizBufRef.current[chIdx];
    if (buf.length >= n) {
      vizBufRef.current[chIdx] = buf.slice(sliceStart);
    }
  }
}

function parseDmxChannelList(text: string, maxCh: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const rangeRe = /^(\d+)\s*-\s*(\d+)$/;

  const add = (raw: number) => {
    const v = Math.floor(raw);
    if (v >= 1 && v <= maxCh && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };

  for (const tok of tokens) {
    const m = tok.trim().match(rangeRe);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (isNaN(a) || isNaN(b)) continue;
      let lo = Math.min(a, b);
      let hi = Math.max(a, b);
      lo = Math.max(1, lo);
      hi = Math.min(maxCh, hi);
      for (let i = lo; i <= hi; i++) add(i);
    } else {
      const n = parseInt(tok, 10);
      if (!isNaN(n)) add(n);
    }
  }
  return out;
}

function normalizeLoadedChannels(channels: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of channels) {
    const ch = Number(raw) | 0;
    if (ch >= 1 && ch <= CHANNELS && !seen.has(ch)) {
      seen.add(ch);
      out.push(ch);
    }
  }
  return out.length ? out : [1];
}

function formatDmxChannelList(channels: number[]): string {
  const normalized = normalizeLoadedChannels(channels);
  const parts: string[] = [];
  let start = normalized[0];
  let prev = normalized[0];

  for (let i = 1; i <= normalized.length; i++) {
    const next = normalized[i];
    if (next === prev + 1) {
      prev = next;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = next;
    prev = next;
  }

  return parts.join(", ");
}

function formatPlaybackTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function decodeWavRecording(path: string): Promise<WavRecording> {
  const bytes = (await invoke("read_binary_file", { path })) as number[];
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Audio decoding is not available in this WebView");
  }
  const audio = await new AudioContextCtor().decodeAudioData(
    new Uint8Array(bytes).buffer
  );
  const timestamps = Array.from({ length: audio.length }, (_, idx) =>
    Math.round((idx * 1000) / audio.sampleRate)
  );
  const channels = Array.from({ length: audio.numberOfChannels }, (_, ch) =>
    Array.from(audio.getChannelData(ch), (value) =>
      Math.round(((Math.max(-1, Math.min(1, value)) + 1) / 2) * 255)
    )
  );
  return { timestamps, channels };
}

type SenderConfig = {
  target_ip: string;
  port: number;
  fps: number;
  net: number;
  subnet: number;
  universe: number;
};

export default function RecordPlayTab(_props: RecordPlayTabProps) {
  const [universes, setUniverses] = useState<UniverseKey[]>([]);
  const [selected, setSelected] = useState<UniverseKey>("");
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [path, setPath] = useState<string>("");
  const universeLastSeenRef = useRef<Map<UniverseKey, number>>(new Map());
  const [blink, setBlink] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<SenderConfig | null>(null);
  const [isLooping, setIsLooping] = useState(false);
  const [recordingFormat, setRecordingFormat] = useState<"jsonl" | "wav">(
    "jsonl"
  );
  const [recordChannels, setRecordChannels] = useState<number[]>([1]);
  const [channelsText, setChannelsText] = useState("1");

  const waveformRows = useMemo(
    () => recordChannels.filter((n) => n >= 1 && n <= CHANNELS),
    [recordChannels]
  );
  const waveformRowsRef = useRef<number[]>([1]);

  useEffect(() => {
    waveformRowsRef.current = waveformRows;
  }, [waveformRows]);

  // Data buffers: timestamps and per-channel arrays of values
  const tRef = useRef<number[]>([]);
  const bufRef = useRef<Uint8Array[]>(
    Array.from({ length: CHANNELS }, () => new Uint8Array(0))
  );

  // Visualization data (downsampled for performance)
  const vizTRef = useRef<number[]>([]);
  const vizBufRef = useRef<Uint8Array[]>(
    Array.from({ length: CHANNELS }, () => new Uint8Array(0))
  );

  const MAX_VIZ_FRAMES = 2000;
  const SAMPLE_RATE = 1;
  const MAX_COMPLETE_FRAMES = 200000;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const incomingSeqRef = useRef(0);
  const drawRafRef = useRef<number | null>(null);
  const frozenVizEndRef = useRef<number | null>(null);
  const playbackStartRef = useRef<number | null>(null);
  const playbackDurationRef = useRef(0);
  const playbackOffsetRef = useRef(0);
  const playbackActiveRef = useRef(false);
  const playbackLoopRef = useRef(false);
  const timelineDragActiveRef = useRef(false);
  const timelineDragWasPlayingRef = useRef(false);

  useEffect(() => {
    playbackLoopRef.current = isLooping;
  }, [isLooping]);

  const resetVisualization = useCallback(() => {
    incomingSeqRef.current = 0;
    vizTRef.current = [];
    vizBufRef.current = Array.from(
      { length: CHANNELS },
      () => new Uint8Array(0)
    );
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Get the actual container dimensions, not the virtual content
    const container = containerRef.current;
    if (!container) return;

    const W = container.clientWidth;
    const H = container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const CW = Math.floor(W * dpr);
    const CH = Math.floor(H * dpr);
    const cssW = `${W}px`;
    const cssH = `${H}px`;

    if (canvas.width !== CW || canvas.height !== CH) {
      canvas.width = CW;
      canvas.height = CH;
    }
    if (canvas.style.width !== cssW) canvas.style.width = cssW;
    if (canvas.style.height !== cssH) canvas.style.height = cssH;

    // scale for crisp rendering
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background glass panel
    ctx.fillStyle = "rgba(10, 16, 24, 0.85)";
    ctx.fillRect(0, 0, W, H);

    const pad = 0;
    const cellH = CELL_H;
    const rows = waveformRowsRef.current;
    const rowCount = rows.length;

    if (rowCount === 0) {
      ctx.fillStyle = "#9fb3c8";
      ctx.font = "12px Inter, system-ui, -apple-system";
      ctx.fillText(
        "Enter one or more channels above to preview traces here.",
        pad,
        pad + 14
      );
      return;
    }

    const vt = vizTRef.current;
    if (vt.length === 0) {
      ctx.fillStyle = "#9fb3c8";
      ctx.font = "12px Inter, system-ui, -apple-system";
      ctx.fillText(
        "Waiting for incoming DMX on the selected universe...",
        pad,
        pad + 14
      );
      return;
    }

    const frozenVizEnd = frozenVizEndRef.current;
    const windowEndMs = frozenVizEnd ?? Date.now();
    const windowStartMs =
      frozenVizEnd == null
        ? windowEndMs - VIZ_PREVIEW_WINDOW_MS
        : Math.max(vt[0], windowEndMs - VIZ_PREVIEW_WINDOW_MS);
    const span = Math.max(1, windowEndMs - windowStartMs);

    const scrollTop = scrollTopRef.current;
    const startRow = Math.max(0, Math.floor(scrollTop / cellH));
    const endRow = Math.min(rowCount - 1, Math.floor((scrollTop + H) / cellH));

    ctx.lineWidth = 1.2;
    for (let rowIdx = startRow; rowIdx <= endRow; rowIdx++) {
      const y0 = rowIdx * cellH - scrollTop;
      const ih = cellH - 6;
      const x0 = GUTTER_W;
      const iw = W - GUTTER_W;
      const dmxNum = rows[rowIdx];
      const chBuf = Math.min(Math.max(dmxNum - 1, 0), CHANNELS - 1);

      ctx.fillStyle =
        rowIdx % 2 === 0
          ? "rgba(255,255,255,0.02)"
          : "rgba(255,255,255,0.03)";
      ctx.fillRect(0, y0, W, ih + 6);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, y0 + ih + 5.5);
      ctx.lineTo(W, y0 + ih + 5.5);
      ctx.stroke();

      ctx.fillStyle = "#9fb3c8";
      ctx.font = "12px Inter, system-ui, -apple-system";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(String(dmxNum), GUTTER_W - 8, y0 + (ih + 6) / 2);

      const vals = vizBufRef.current[chBuf];
      if (!vals || vals.length === 0) continue;
      const plotW = Math.max(2, Math.floor(iw));
      const valueCount = Math.min(vt.length, vals.length);
      if (valueCount === 0) continue;
      const lastValueTime = vt[valueCount - 1];
      const startTime = Math.max(windowStartMs, vt[0]);
      const endTime = Math.min(
        windowEndMs,
        lastValueTime + (frozenVizEnd == null ? VIZ_HOLD_LAST_MS : 0)
      );
      if (endTime < startTime) continue;
      const sampleAt = (t: number) => {
        if (valueCount >= vt.length) return interpolatedSample(vt, vals, t);
        if (t <= vt[0]) return vals[0];
        if (t >= vt[valueCount - 1]) return vals[valueCount - 1];
        let lo = 0;
        let hi = valueCount - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (vt[mid] <= t) lo = mid;
          else hi = mid;
        }
        const t0 = vt[lo];
        const t1 = vt[hi];
        const v0 = vals[lo];
        const v1 = vals[hi];
        const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        return v0 + (v1 - v0) * u;
      };
      const startPx = Math.max(
        0,
        Math.min(
          plotW - 1,
          Math.floor(((startTime - windowStartMs) / span) * (plotW - 1))
        )
      );
      const endPx = Math.max(
        startPx,
        Math.min(
          plotW - 1,
          Math.ceil(((endTime - windowStartMs) / span) * (plotW - 1))
        )
      );
      const stride = plotW > 900 ? 2 : 1;
      ctx.beginPath();
      let first = true;
      for (let px = startPx; px <= endPx; px += stride) {
        const tt = windowStartMs + (span * px) / Math.max(1, plotW - 1);
        const v = sampleAt(tt);
        const y = y0 + (ih - 1) * (1 - v / 255);
        const x = x0 + px;
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (!first && (endPx - startPx) % stride !== 0) {
        const tt = windowStartMs + (span * endPx) / Math.max(1, plotW - 1);
        const v = sampleAt(tt);
        ctx.lineTo(x0 + endPx, y0 + (ih - 1) * (1 - v / 255));
      }
      ctx.strokeStyle = "#5ab0ff";
      ctx.stroke();
    }

    if (frozenVizEnd != null || playbackActiveRef.current) {
      const duration =
        playbackDurationRef.current || Math.max(1, vt[vt.length - 1] - vt[0]);
      if (duration > 0) {
        const isPlayingNow =
          playbackActiveRef.current && playbackStartRef.current != null;
        const elapsed = isPlayingNow
          ? playbackOffsetRef.current +
            performance.now() -
            (playbackStartRef.current ?? 0)
          : playbackOffsetRef.current;
        const clampedElapsed = Math.min(Math.max(0, elapsed), duration);
        const progress = clampedElapsed / duration;
        const plotX = GUTTER_W;
        const plotW = Math.max(2, W - GUTTER_W);
        const cursorX = plotX + progress * (plotW - 1);
        const label = `${formatPlaybackTime(clampedElapsed)} / ${formatPlaybackTime(
          duration
        )}`;

        ctx.save();
        ctx.strokeStyle = "#ffb454";
        ctx.fillStyle = "#ffb454";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cursorX + 0.5, 0);
        ctx.lineTo(cursorX + 0.5, H);
        ctx.stroke();
        ctx.font = "11px Inter, system-ui, -apple-system";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText(label, W - 8, 4);
        ctx.restore();

        if (isPlayingNow && elapsed >= duration) {
          if (playbackLoopRef.current) {
            playbackOffsetRef.current = 0;
            playbackStartRef.current = performance.now();
          } else {
            playbackOffsetRef.current = duration;
            playbackActiveRef.current = false;
            playbackStartRef.current = null;
            setIsPlaying(false);
          }
        }
      }
    }
  }, []);

  useEffect(() => {
    let unlisten: Promise<UnlistenFn> | null = null;
    unlisten = listen<Frame>("artnet:dmx", (e) => {
      const p = e.payload;
      if (!p) return;
      const key: UniverseKey = `${p.net}/${p.subnet}/${p.universe}`;
      universeLastSeenRef.current.set(key, Date.now());
      setUniverses((prev) => (prev.includes(key) ? prev : [...prev, key]));
      setSelected((prev) => prev || key);
    });
    return () => {
      unlisten?.then((fn) => fn());
    };
  }, []);

  // Universe data capture
  useEffect(() => {
    let unlisten: Promise<UnlistenFn> | null = null;
    unlisten = listen<Frame>("artnet:dmx_filtered", (e) => {
      const p = e.payload;
      if (!p) return;
      const stamp = Date.now();
      const values = p.values || [];
      const key: UniverseKey = `${p.net}/${p.subnet}/${p.universe}`;
      universeLastSeenRef.current.set(key, stamp);
      setUniverses((prev) => (prev.includes(key) ? prev : [...prev, key]));
      setSelected((prev) => prev || key);
      if (!isRecording && frozenVizEndRef.current != null) return;

      if (isRecording) {
        tRef.current.push(stamp);
        recordChannels.forEach((ch) => {
          const chIdx = Math.min(Math.max(ch - 1, 0), CHANNELS - 1);
          const v = values[chIdx] | 0;
          const prev = bufRef.current[chIdx];
          const next = new Uint8Array(prev.length + 1);
          if (prev.length) next.set(prev, 0);
          next[prev.length] = v;
          bufRef.current[chIdx] = next;
        });

        if (tRef.current.length > MAX_COMPLETE_FRAMES) {
          const keep = Math.floor(MAX_COMPLETE_FRAMES * 0.5);
          tRef.current = tRef.current.slice(-keep);
          for (let ch = 0; ch < CHANNELS; ch++) {
            bufRef.current[ch] = bufRef.current[ch].slice(-keep);
          }
        }
      }

      incomingSeqRef.current += 1;
      const shouldSample =
        waveformRows.length > 0 &&
        (incomingSeqRef.current - 1) % SAMPLE_RATE === 0;
      if (shouldSample) {
        vizTRef.current.push(stamp);
        waveformRows.forEach((dmx) => {
          const chIdx = Math.min(Math.max(dmx - 1, 0), CHANNELS - 1);
          const v = values[chIdx] | 0;
          const prev = vizBufRef.current[chIdx];
          const next = new Uint8Array(prev.length + 1);
          if (prev.length) next.set(prev, 0);
          next[prev.length] = v;
          vizBufRef.current[chIdx] = next;
        });
      }

      if (!isRecording) {
        trimVizBeforeTime(
          stamp - VIZ_PREVIEW_WINDOW_MS,
          waveformRows,
          vizTRef,
          vizBufRef
        );
      } else if (vizTRef.current.length > MAX_VIZ_FRAMES) {
        const keep = Math.floor(MAX_VIZ_FRAMES * 0.8);
        vizTRef.current = vizTRef.current.slice(-keep);
        waveformRows.forEach((dmx) => {
          const chIdx = Math.min(Math.max(dmx - 1, 0), CHANNELS - 1);
          vizBufRef.current[chIdx] = vizBufRef.current[chIdx].slice(-keep);
        });
      }
    });
    return () => {
      unlisten?.then((fn) => fn());
    };
  }, [
    isRecording,
    selected,
    draw,
    recordChannels,
    waveformRows,
  ]);

  useEffect(() => {
    if (isRecording) return;
    if (frozenVizEndRef.current != null) return;
    trimVizBeforeTime(
      Date.now() - VIZ_PREVIEW_WINDOW_MS,
      waveformRows,
      vizTRef,
      vizBufRef
    );
  }, [isRecording, waveformRows]);

  useEffect(() => {
    const tick = () => {
      draw();
      drawRafRef.current = requestAnimationFrame(tick);
    };
    drawRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (drawRafRef.current != null) {
        cancelAnimationFrame(drawRafRef.current);
      }
    };
  }, [draw]);

  // TTL prune universes and control blink state for selected
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setUniverses((prev) => {
        const keep = prev.filter((k) => {
          const last = universeLastSeenRef.current.get(k) || 0;
          return now - last <= 10000; // 10s TTL
        });
        if (
          keep.length !== prev.length &&
          selected &&
          !keep.includes(selected)
        ) {
          setSelected(keep[0] || "");
        }
        return keep;
      });
      // blink when selected has recent frames
      if (selected) {
        const last = universeLastSeenRef.current.get(selected) || 0;
        const active = now - last < 300; // recent frame within 300ms
        setBlink((b) => (active ? !b : false));
      } else {
        setBlink(false);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [selected]);

  // Apply backend filter whenever selection changes
  useEffect(() => {
    if (!selected) return;
    const [n, s, u] = selected.split("/").map((v) => Number(v) | 0);
    invoke("set_event_filter", { filter: { net: n, subnet: s, universe: u } });
    return () => {
      invoke("set_event_filter", { filter: null });
    };
  }, [selected]);

  // Resize observer
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      requestAnimationFrame(draw);
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Ensure scroll updates are captured reliably (WebKit/WebView fallback)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollTopRef.current = el.scrollTop;
      // Use setTimeout to ensure updates continue in background
      setTimeout(() => requestAnimationFrame(draw), 0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [draw]);

  // Drawing

  useEffect(() => {
    draw();
  }, [draw]);

  // Controls
  const chooseOpen = useCallback(async () => {
    const p = await dialogOpen({
      multiple: false,
      filters: [
        { name: "ArtNet Files", extensions: ["jsonl", "json", "wav"] },
        { name: "ArtNet JSONL", extensions: ["jsonl", "json"] },
        { name: "ArtNet WAV", extensions: ["wav"] },
      ],
    });
    if (!p) return;
    const newPath = String(p);
    if (
      tRef.current.length > 0 &&
      !window.confirm("Discard current unsaved recording and load file?")
    )
      return;

    const isWavFile = newPath.toLowerCase().endsWith(".wav");
    let loadedKey: UniverseKey | "" = "";
    let vizChannelNums: number[] = [];
    let nextT: number[] = [];
    let nextBuf = Array.from({ length: CHANNELS }, () => new Uint8Array(0));

    try {
      if (isWavFile) {
        let wav: WavRecording;
        try {
          wav = (await invoke("load_wav_recording", {
            path: newPath,
          })) as WavRecording;
          if (wav.timestamps.length === 0 || wav.channels.length === 0) {
            wav = await decodeWavRecording(newPath);
          }
        } catch {
          wav = await decodeWavRecording(newPath);
        }
        nextT = wav.timestamps.map((t) => Number(t) || 0);
        vizChannelNums = normalizeLoadedChannels(
          wav.dmx_channels && wav.dmx_channels.length === wav.channels.length
            ? wav.dmx_channels
            : wav.channels.map((_, idx) => idx + 1)
        );
        vizChannelNums.forEach((dmx, idx) => {
          const chIdx = dmx - 1;
          const values = wav.channels[idx] || [];
          nextBuf[chIdx] = new Uint8Array(
            values.map((value) => Number(value) | 0)
          );
        });
      } else {
        const content = (await invoke("read_text_file", {
          path: newPath,
        })) as string;
        const lines = content.split(/\r?\n/).filter(Boolean);
        let channels = Array.from({ length: CHANNELS }, (_, idx) => idx + 1);
        let start = 0;
        if (lines[0]?.includes("format") && lines[0].includes("artnet-jsonl")) {
          const header = JSON.parse(lines[0]);
          if (Array.isArray(header.channels)) {
            channels = normalizeLoadedChannels(header.channels);
          } else if (typeof header.channel === "number") {
            channels = normalizeLoadedChannels([header.channel]);
          }
          start = 1;
        }
        vizChannelNums = normalizeLoadedChannels(channels);
        for (let i = start; i < lines.length; i++) {
          const rec = JSON.parse(lines[i]);
          const values = Array.isArray(rec.values) ? rec.values : [];
          const t = Number(rec.t_ms) || 0;
          if (!loadedKey && typeof rec.net === "number") {
            loadedKey = `${rec.net | 0}/${rec.subnet | 0}/${rec.universe | 0}`;
          }
          nextT.push(t);
          vizChannelNums.forEach((dmx, idx) => {
            const ch = dmx - 1;
            const v = Number(values[idx]) | 0;
            const prev = nextBuf[ch];
            const next = new Uint8Array(prev.length + 1);
            if (prev.length) next.set(prev);
            next[prev.length] = v;
            nextBuf[ch] = next;
          });
        }
      }
      const hasSamples = vizChannelNums.some(
        (dmx) => nextBuf[dmx - 1]?.length > 0
      );
      if (nextT.length === 0 || !hasSamples) {
        throw new Error("Loaded file contains no drawable samples");
      }
    } catch (e) {
      alert(`Could not load recording: ${String(e)}`);
      return;
    }

    incomingSeqRef.current = 0;
    frozenVizEndRef.current = null;
    tRef.current = nextT.slice();
    bufRef.current = nextBuf;
    vizTRef.current = nextT;
    vizBufRef.current = nextBuf;
    waveformRowsRef.current = vizChannelNums;
    setRecordChannels(vizChannelNums);
    setChannelsText(formatDmxChannelList(vizChannelNums));
    frozenVizEndRef.current =
      vizTRef.current.length > 0
        ? vizTRef.current[vizTRef.current.length - 1]
        : null;
    playbackOffsetRef.current = 0;
    playbackDurationRef.current = Math.max(1, nextT[nextT.length - 1] - nextT[0]);
    playbackActiveRef.current = false;
    playbackStartRef.current = null;
    setIsPlaying(false);

    if (loadedKey) {
      setUniverses((prev) =>
        prev.includes(loadedKey) ? prev : [...prev, loadedKey]
      );
      setSelected(loadedKey);
    }
    setPath(newPath);
    requestAnimationFrame(draw);
  }, [draw]);

  const toggleRecord = useCallback(() => {
    if (!isRecording) {
      frozenVizEndRef.current = null;
      incomingSeqRef.current = 0;
      tRef.current = [];
      bufRef.current = Array.from(
        { length: CHANNELS },
        () => new Uint8Array(0)
      );
      vizTRef.current = [];
      vizBufRef.current = Array.from(
        { length: CHANNELS },
        () => new Uint8Array(0)
      );
      setIsRecording(true);
    } else {
      frozenVizEndRef.current =
        vizTRef.current.length > 0
          ? vizTRef.current[vizTRef.current.length - 1]
          : Date.now();
      playbackOffsetRef.current = 0;
      playbackDurationRef.current = Math.max(
        1,
        (vizTRef.current[vizTRef.current.length - 1] ?? 0) -
          (vizTRef.current[0] ?? 0)
      );
      setIsRecording(false);
      requestAnimationFrame(draw);
    }
  }, [draw, isRecording]);

  const saveToFile = useCallback(async () => {
    if (tRef.current.length === 0) return;
    const extension = recordingFormat === "wav" ? "wav" : "jsonl";
    const p = await dialogSave({
      defaultPath: `recording.${extension}`,
      filters: [
        { name: "ArtNet JSONL", extensions: ["jsonl"] },
        { name: "ArtNet WAV", extensions: ["wav"] },
      ],
    });
    if (!p) return;

    if (recordingFormat === "wav") {
      // Save as WAV format
      const t0 = tRef.current[0];
      const duration = tRef.current[tRef.current.length - 1] - t0;
      const sampleRate = Math.max(
        1,
        Math.floor((tRef.current.length * 1000) / duration)
      );

      await invoke("save_wav_recording", {
        path: String(p),
        sampleRate,
        data: {
          timestamps: tRef.current.map((t) => t - t0),
          dmx_channels: recordChannels,
          channels: recordChannels.map((ch) =>
            Array.from(
              bufRef.current[Math.min(Math.max(ch - 1, 0), CHANNELS - 1)]
            )
          ),
        },
      });
    } else {
      // Save as JSONL format
      const t0 = tRef.current[0];
      const lines: string[] = [];
      lines.push(
        JSON.stringify({
          format: "artnet-jsonl",
          version: 1,
          channels: recordChannels,
        })
      );
      for (let i = 0; i < tRef.current.length; i++) {
        const t_ms = tRef.current[i] - t0;
        const vals = recordChannels.map((ch) => {
          const chIdx = Math.min(Math.max(ch - 1, 0), CHANNELS - 1);
          return bufRef.current[chIdx][i] | 0;
        });
        // Include addressing of the selected universe if available
        let net = 0,
          subnet = 0,
          universe = 0;
        if (selected) {
          const [n, s, u] = selected.split("/").map((v) => Number(v) | 0);
          net = n;
          subnet = s;
          universe = u;
        }
        lines.push(
          JSON.stringify({
            t_ms,
            net,
            subnet,
            universe,
            length: recordChannels.length,
            values: vals,
          })
        );
      }
      const content = lines.join("\n") + "\n";
      await invoke("write_text_file", { path: String(p), content });
    }

    setPath(String(p));
  }, [selected, recordingFormat, recordChannels]);

  const getPlaybackDuration = useCallback(() => {
    const firstT = vizTRef.current[0] ?? tRef.current[0] ?? 0;
    const lastT =
      vizTRef.current[vizTRef.current.length - 1] ??
      tRef.current[tRef.current.length - 1] ??
      firstT;
    return Math.max(1, lastT - firstT);
  }, []);

  const outputSeekedFrame = useCallback(
    async (offsetMs: number) => {
      const vt = vizTRef.current;
      if (vt.length === 0) return;
      const target = vt[0] + offsetMs;
      let idx = 0;
      while (idx < vt.length - 1 && vt[idx + 1] <= target) idx++;
      const values = Array.from({ length: CHANNELS }, (_, ch) => {
        const buf = vizBufRef.current[ch];
        return buf?.[Math.min(idx, Math.max(0, buf.length - 1))] ?? 0;
      });
      const isWavFile = path.toLowerCase().endsWith(".wav");
      const [net, subnet, universe] =
        selected && !isWavFile
          ? selected.split("/").map((value) => Number(value) | 0)
          : [undefined, undefined, undefined];
      await invoke("send_dmx_values", {
        values,
        net,
        subnet,
        universe,
      }).catch(() => {});
    },
    [path, selected]
  );

  const seekTimelineFromClientX = useCallback(
    (clientX: number) => {
      const container = containerRef.current;
      if (!container || frozenVizEndRef.current == null) return false;
      const rect = container.getBoundingClientRect();
      const plotX = GUTTER_W;
      const plotW = Math.max(2, rect.width - GUTTER_W);
      const x = Math.min(Math.max(clientX - rect.left, plotX), plotX + plotW);
      const progress = (x - plotX) / plotW;
      playbackDurationRef.current = getPlaybackDuration();
      playbackOffsetRef.current = Math.min(
        playbackDurationRef.current,
        Math.max(0, progress * playbackDurationRef.current)
      );
      playbackStartRef.current = performance.now();
      requestAnimationFrame(draw);
      void outputSeekedFrame(playbackOffsetRef.current);
      return true;
    },
    [draw, getPlaybackDuration, outputSeekedFrame]
  );

  const startPlaybackFromOffset = useCallback(
    async (offsetMs = playbackOffsetRef.current) => {
      if (!path) {
        alert("Please load or save a recording to play.");
        return;
      }
      const duration = getPlaybackDuration();
      const startMs = Math.min(Math.max(0, offsetMs), duration);
      const playStartMs = startMs >= duration ? 0 : startMs;

      try {
        const isWavFile = path.toLowerCase().endsWith(".wav");
        if (isWavFile) {
          await invoke("play_wav_file", {
            path,
            startMs: Math.round(playStartMs),
            loopPlayback: isLooping,
          });
        } else {
          await invoke("play_file", {
            path,
            startMs: Math.round(playStartMs),
            loopPlayback: isLooping,
          });
        }
        playbackDurationRef.current = duration;
        playbackOffsetRef.current = playStartMs;
        playbackStartRef.current = performance.now();
        playbackActiveRef.current = true;
        setIsPlaying(true);
        requestAnimationFrame(draw);
      } catch (e) {
        playbackActiveRef.current = false;
        playbackStartRef.current = null;
        alert(`Could not start playback: ${String(e)}`);
      }
    },
    [draw, getPlaybackDuration, isLooping, path]
  );

  const togglePlay = useCallback(async () => {
    if (!isPlaying) {
      await startPlaybackFromOffset();
    } else {
      const duration = playbackDurationRef.current || getPlaybackDuration();
      if (playbackStartRef.current != null) {
        playbackOffsetRef.current = Math.min(
          duration,
          playbackOffsetRef.current + performance.now() - playbackStartRef.current
        );
      }
      await invoke("stop_playback");
      playbackActiveRef.current = false;
      playbackStartRef.current = null;
      setIsPlaying(false);
      requestAnimationFrame(draw);
    }
  }, [draw, getPlaybackDuration, isPlaying, startPlaybackFromOffset]);

  const handleTimelinePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (frozenVizEndRef.current == null) return;
      e.preventDefault();
      timelineDragActiveRef.current = true;
      timelineDragWasPlayingRef.current = playbackActiveRef.current;
      e.currentTarget.setPointerCapture(e.pointerId);
      if (timelineDragWasPlayingRef.current) {
        playbackActiveRef.current = false;
        playbackStartRef.current = null;
        setIsPlaying(false);
        void invoke("stop_playback");
      }
      seekTimelineFromClientX(e.clientX);
    },
    [seekTimelineFromClientX]
  );

  const handleTimelinePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!timelineDragActiveRef.current) return;
      e.preventDefault();
      seekTimelineFromClientX(e.clientX);
    },
    [seekTimelineFromClientX]
  );

  const finishTimelineDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>, restartPlayback: boolean) => {
      if (!timelineDragActiveRef.current) return;
      timelineDragActiveRef.current = false;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (restartPlayback && timelineDragWasPlayingRef.current) {
        void startPlaybackFromOffset(playbackOffsetRef.current);
      }
      timelineDragWasPlayingRef.current = false;
    },
    [startPlaybackFromOffset]
  );

  const clearBuffer = useCallback(() => {
    frozenVizEndRef.current = null;
    playbackOffsetRef.current = 0;
    playbackDurationRef.current = 0;
    playbackActiveRef.current = false;
    playbackStartRef.current = null;
    resetVisualization();
    tRef.current = [];
    bufRef.current = Array.from({ length: CHANNELS }, () => new Uint8Array(0));
    requestAnimationFrame(draw);
  }, [draw, resetVisualization]);

  // Open settings and load current sender config
  const openSettings = useCallback(async () => {
    try {
      const cfg = (await invoke("get_sender_config")) as any;
      const s: SenderConfig = {
        target_ip: String(cfg.target_ip ?? "255.255.255.255"),
        port: Number(cfg.port ?? 6454),
        fps: Number(cfg.fps ?? 44),
        net: Number(cfg.net ?? 0),
        subnet: Number(cfg.subnet ?? 0),
        universe: Number(cfg.universe ?? 0),
      };
      setSettings(s);
      setShowSettings(true);
    } catch (e) {
      setSettings({
        target_ip: "255.255.255.255",
        port: 6454,
        fps: 44,
        net: 0,
        subnet: 0,
        universe: 0,
      });
      setShowSettings(true);
    }
  }, []);

  const saveSettings = useCallback(async () => {
    if (!settings) return;
    await invoke("set_sender_config", {
      cfg: {
        target_ip: settings.target_ip,
        port: settings.port,
        fps: settings.fps,
        net: settings.net,
        subnet: settings.subnet,
        universe: settings.universe,
      },
    });
    await invoke("save_settings").catch(() => {});
    setShowSettings(false);
  }, [settings]);

  const activityColor = isRecording ? "#ff4d4d" : "#2da8ff";
  const activityGlow = isRecording
    ? "0 0 8px rgba(255,77,77,0.9)"
    : "0 0 8px rgba(45,168,255,0.9)";

  return (
    <section className="view active">
      <div className="controls">
        <div className="controls-left">
          <select
            value={selected}
            onChange={(e) => {
              const v = e.currentTarget.value;
              resetVisualization();
              setSelected(v);
              requestAnimationFrame(draw);
            }}
            className="animation-select"
          >
            {universes.length === 0 && <option value="">No universes</option>}
            {universes.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <label className="animation-label">Format:</label>
          <select
            value={recordingFormat}
            onChange={(e) =>
              setRecordingFormat(e.target.value as "jsonl" | "wav")
            }
            className="animation-select"
          >
            <option value="jsonl">JSONL (Text)</option>
            <option value="wav">WAV (Binary)</option>
          </select>
          <label className="animation-label">Channels:</label>
          <span
            className="recordplay-help"
            tabIndex={0}
            data-tooltip="Waveforms update live from DMX on the selected universe. Use comma or space-separated slots (1-512), inclusive ranges like 3-18, or both, e.g. 1-10, 1, 5, 192. Order is preserved; repeats are dropped. Recording writes only those channels to JSONL/WAV."
          >
            ?
          </span>
          <input
            type="text"
            value={channelsText}
            onChange={(e) => {
              const text = e.target.value;
              const channels = parseDmxChannelList(text, CHANNELS);
              setChannelsText(text);
              resetVisualization();
              waveformRowsRef.current = channels;
              setRecordChannels(channels);
              requestAnimationFrame(draw);
            }}
            className="freq-input record-channels-input"
          />
          <span
            title={blink ? "DMX activity" : "No recent frames"}
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              marginLeft: 8,
              borderRadius: 6,
              background: blink ? activityColor : "#244860",
              boxShadow: blink ? activityGlow : "none",
              transition: "background 0.1s",
            }}
          />
          <button className="btn" onClick={toggleRecord}>
            {isRecording ? "Stop" : "Record"}
          </button>
          <button
            className="btn"
            onClick={clearBuffer}
            title="Clear current curves"
          >
            Clear
          </button>
          <button
            className="btn"
            onClick={saveToFile}
            disabled={tRef.current.length === 0}
          >
            Save…
          </button>
          <button className="btn" onClick={chooseOpen}>
            Load…
          </button>
          <button className="btn" onClick={togglePlay}>
            {isPlaying ? "Stop" : "Play"}
          </button>
          <label className="animation-label">
            <input
              type="checkbox"
              checked={isLooping}
              onChange={(e) => setIsLooping(e.currentTarget.checked)}
            />{" "}
            Loop
          </label>
        </div>
        <div className="controls-right">
          <button
            className="iconbtn"
            title="Player Settings"
            onClick={openSettings}
          >
            🎛️
          </button>
        </div>
      </div>
      {path && (
        <div className="recordplay-file-path" title={path}>
          {path}
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={(e) => {
          scrollTopRef.current = (e.target as HTMLDivElement).scrollTop;
          draw();
        }}
        onPointerDown={handleTimelinePointerDown}
        onPointerMove={handleTimelinePointerMove}
        onPointerUp={(e) => finishTimelineDrag(e, true)}
        onPointerCancel={(e) => finishTimelineDrag(e, false)}
        style={{
          width: "100%",
          height: "calc(100vh - 220px)",
          minHeight: 360,
          borderRadius: 12,
          overflowY: "auto",
          position: "relative",
          border: "1px solid var(--glass-border)",
          background: "var(--glass-bg)",
          cursor: path ? "crosshair" : "default",
          backdropFilter: "var(--blur)" as any,
        }}
      >
        <div
          style={{
            height: 0,
            position: "sticky",
            top: 0,
            zIndex: 1,
            pointerEvents: "none",
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              display: "block",
              pointerEvents: "none",
            }}
          />
        </div>
        {waveformRows.length === 0 ? (
          <div className="recordplay-waveform-empty" aria-hidden="true" />
        ) : (
          <div style={{ height: waveformRows.length * CELL_H }} />
        )}
      </div>
      {showSettings && settings && (
        <div
          className={`modal-backdrop ${showSettings ? "show" : ""}`}
          onMouseDown={() => setShowSettings(false)}
        >
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <h3>Playback Sender Settings</h3>
            <div className="row">
              <label>Target IP</label>
              <input
                value={settings.target_ip}
                onChange={(e) =>
                  setSettings({ ...settings, target_ip: e.currentTarget.value })
                }
              />
            </div>
            <div className="row">
              <label>Port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={settings.port}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    port: Number(e.currentTarget.value),
                  })
                }
              />
            </div>
            <div className="row">
              <label>Frequency (Hz)</label>
              <input
                type="number"
                min={1}
                max={120}
                value={settings.fps}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    fps: Number(e.currentTarget.value),
                  })
                }
              />
            </div>
            <div className="row">
              <label>Net</label>
              <input
                type="number"
                min={0}
                max={127}
                value={settings.net}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    net: Number(e.currentTarget.value),
                  })
                }
              />
            </div>
            <div className="row">
              <label>Subnet</label>
              <input
                type="number"
                min={0}
                max={15}
                value={settings.subnet}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    subnet: Number(e.currentTarget.value),
                  })
                }
              />
            </div>
            <div className="row">
              <label>Universe</label>
              <input
                type="number"
                min={0}
                max={15}
                value={settings.universe}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    universe: Number(e.currentTarget.value),
                  })
                }
              />
            </div>
            <div className="actions">
              <button className="btn" onClick={saveSettings}>
                Save
              </button>
              <button className="btn" onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
