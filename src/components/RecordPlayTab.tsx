import { useCallback, useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type Frame = {
  values: number[];
  net: number;
  subnet: number;
  universe: number;
};

type UniverseKey = string; // "net/subnet/universe"

interface RecordPlayTabProps {}

const COLS = 32;
const ROWS = 16;
const CHANNELS = 512;

export default function RecordPlayTab(_props: RecordPlayTabProps) {
  const [universes, setUniverses] = useState<UniverseKey[]>([]);
  const [selected, setSelected] = useState<UniverseKey>("");
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [path, setPath] = useState<string>("");

  // Data buffers: timestamps and per-channel arrays of values
  const tRef = useRef<number[]>([]);
  const bufRef = useRef<Uint8Array[]>(Array.from({ length: CHANNELS }, () => new Uint8Array(0)));

  // Canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });

  // Universe discovery and data capture
  useEffect(() => {
    let unlisten: Promise<UnlistenFn> | null = null;
    unlisten = listen<Frame>("artnet:dmx", (e) => {
      const p = e.payload;
      if (!p) return;
      const key: UniverseKey = `${p.net}/${p.subnet}/${p.universe}`;
      setUniverses((prev) => (prev.includes(key) ? prev : [...prev, key]));
      if (!selected) setSelected(key);
      if (!selected || key !== selected) return; // capture only selected

      // Append snapshot
      const now = Date.now();
      const values = p.values || [];
      tRef.current.push(now);
      for (let ch = 0; ch < CHANNELS; ch++) {
        const v = values[ch] | 0;
        const prev = bufRef.current[ch];
        const next = new Uint8Array(prev.length + 1);
        if (prev.length) next.set(prev, 0);
        next[prev.length] = v;
        bufRef.current[ch] = next;
      }
      requestAnimationFrame(draw);
    });
    return () => {
      unlisten?.then((fn) => fn());
    };
  }, [selected]);

  // Resize observer
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      setSize({ w: Math.max(300, r.width), h: Math.max(300, r.height) });
      requestAnimationFrame(draw);
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Drawing
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = size.w, H = size.h;
    const dpr = window.devicePixelRatio || 1;
    const CW = Math.floor(W * dpr);
    const CH = Math.floor(H * dpr);
    if (canvas.width !== CW || canvas.height !== CH) {
      canvas.width = CW; canvas.height = CH;
    }
    // scale for crisp rendering
    // @ts-ignore
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Background glass panel
    ctx.fillStyle = "rgba(10, 16, 24, 0.85)";
    ctx.fillRect(0, 0, W, H);

    const pad = 8;
    const cellW = (W - pad * 2) / COLS;
    const cellH = (H - pad * 2) / ROWS;
    const xs = tRef.current.length;
    if (xs === 0) {
      // hint text
      ctx.fillStyle = "#9fb3c8";
      ctx.font = "12px Inter, system-ui, -apple-system";
      ctx.fillText("No data yet — press Record or Play to visualize", pad, pad + 14);
      return;
    }

    // Mapping time to X
    const t0 = tRef.current[0];
    const tN = tRef.current[xs - 1];
    const span = Math.max(1, tN - t0);

    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "#70c7ff";

    for (let ch = 0; ch < CHANNELS; ch++) {
      const row = Math.floor(ch / COLS);
      const col = ch % COLS;
      const x0 = pad + col * cellW;
      const y0 = pad + row * cellH;
      const ih = cellH - 4;
      const iw = cellW - 4;

      // Cell border
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, iw + 3, ih + 3);

      // Trace
      ctx.beginPath();
      let first = true;
      const vals = bufRef.current[ch];
      for (let i = 0; i < xs; i++) {
        const x = x0 + 2 + (iw - 1) * ((tRef.current[i] - t0) / span);
        const v = vals[i] || 0;
        const y = y0 + 2 + (ih - 1) * (1 - v / 255);
        if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
      }
      ctx.strokeStyle = "#5ab0ff";
      ctx.stroke();
    }
  }, [size.w, size.h]);

  useEffect(() => { draw(); }, [draw]);

  // Controls
  const chooseOpen = useCallback(async () => {
    const dialog = (window as any).__TAURI__?.dialog;
    const p = await dialog?.open({ multiple: false, filters: [{ name: "ArtNet JSONL", extensions: ["jsonl", "json"] }] });
    if (p) setPath(String(p));
  }, []);
  const chooseSaveAndRecord = useCallback(async () => {
    const dialog = (window as any).__TAURI__?.dialog;
    const p = await dialog?.save({ defaultPath: "recording.jsonl", filters: [{ name: "JSON Lines", extensions: ["jsonl"] }] });
    if (p) {
      // reset buffers
      tRef.current = [];
      bufRef.current = Array.from({ length: CHANNELS }, () => new Uint8Array(0));
      setPath(String(p));
      await invoke("start_recording", { path: String(p) });
      setIsRecording(true);
    }
  }, []);
  const stopRec = useCallback(async () => {
    await invoke("stop_recording");
    setIsRecording(false);
  }, []);
  const play = useCallback(async () => {
    if (!path) return;
    setIsPlaying(true);
    await invoke("play_file", { path });
    setIsPlaying(false);
  }, [path]);
  const stopPlay = useCallback(async () => {
    await invoke("stop_playback");
    setIsPlaying(false);
  }, []);

  return (
    <section className="view active">
      <div className="controls">
        <div className="controls-left">
          <select
            value={selected}
            onChange={(e) => setSelected(e.currentTarget.value)}
            className="animation-select"
          >
            {universes.length === 0 && <option value="">No universes</option>}
            {universes.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
          <button className="btn" onClick={chooseSaveAndRecord} disabled={isRecording}>Record…</button>
          <button className="btn danger" onClick={stopRec} disabled={!isRecording}>Stop</button>
          <button className="btn" onClick={chooseOpen}>Load…</button>
          <button className="btn" onClick={play} disabled={!path || isPlaying}>Play</button>
          <button className="btn danger" onClick={stopPlay} disabled={!isPlaying}>Stop Play</button>
          <span className="status">{path}</span>
        </div>
        <div className="controls-right">
          <button className="iconbtn" title="Player Settings">🎛️</button>
        </div>
      </div>
      <div ref={containerRef} style={{ width: "100%", height: "calc(100vh - 220px)", minHeight: 300, borderRadius: 12, overflow: "hidden", border: "1px solid var(--glass-border)", background: "var(--glass-bg)", backdropFilter: "var(--blur)" as any }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      </div>
    </section>
  );
}
