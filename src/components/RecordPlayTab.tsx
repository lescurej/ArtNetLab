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
  const scrollTopRef = useRef(0);

  // Universe discovery and data capture
  useEffect(() => {
    let unlisten: Promise<UnlistenFn> | null = null;
    unlisten = listen<Frame>("artnet:dmx_filtered", (e) => {
      const p = e.payload;
      if (!p) return;
      const key: UniverseKey = `${p.net}/${p.subnet}/${p.universe}`;
      setUniverses((prev) => (prev.includes(key) ? prev : [...prev, key]));
      if (!selected) setSelected(key);

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
  }, []);

  // Apply backend filter whenever selection changes
  useEffect(() => {
    if (!selected) return;
    const [n, s, u] = selected.split("/").map((v) => Number(v) | 0);
    invoke("set_event_filter", { filter: { net: n, subnet: s, universe: u } });
    return () => { invoke("set_event_filter", { filter: null }); };
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
    const cellH = 14; // one channel per line
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

    // Virtualize vertically: draw only visible rows
    // total height would be CHANNELS * cellH + pad * 2 (virtualized)
    const scrollTop = scrollTopRef.current;
    const startRow = Math.max(0, Math.floor((scrollTop - pad) / cellH));
    const endRow = Math.min(CHANNELS - 1, Math.ceil((scrollTop + H - pad) / cellH));

    ctx.lineWidth = 1.2;
    for (let ch = startRow; ch <= endRow; ch++) {
      const y0 = pad + ch * cellH - scrollTop;
      const ih = cellH - 3;
      const x0 = pad;
      const iw = W - pad * 2;
      // baseline
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.moveTo(x0, y0 + ih);
      ctx.lineTo(x0 + iw, y0 + ih);
      ctx.stroke();

      // Trace downsampled per pixel
      const vals = bufRef.current[ch];
      if (!vals || vals.length === 0) continue;
      ctx.beginPath();
      let first = true;
      for (let px = 0; px < iw; px++) {
        const tt = t0 + (span * px) / Math.max(1, iw - 1);
        let idx = Math.floor(((tt - t0) / span) * (xs - 1));
        if (idx < 0) idx = 0; if (idx >= xs) idx = xs - 1;
        const v = vals[idx] || 0;
        const y = y0 + (ih - 1) * (1 - v / 255);
        const x = x0 + px;
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
    if (!p) return;
    const newPath = String(p);
    if (tRef.current.length > 0 && !window.confirm("Discard current unsaved recording and load file?")) return;
    const content = (await invoke("read_text_file", { path: newPath })) as string;
    tRef.current = [];
    bufRef.current = Array.from({ length: CHANNELS }, () => new Uint8Array(0));
    const lines = content.split(/\r?\n/).filter(Boolean);
    let i = 0;
    if (lines[0] && lines[0].includes("format") && lines[0].includes("artnet-jsonl")) i = 1;
    for (; i < lines.length; i++) {
      const obj = JSON.parse(lines[i]);
      const t_ms = obj.t_ms as number;
      const values = obj.values as number[];
      tRef.current.push(t_ms);
      for (let ch = 0; ch < CHANNELS; ch++) {
        const prev = bufRef.current[ch];
        const next = new Uint8Array(prev.length + 1);
        if (prev.length) next.set(prev, 0);
        next[prev.length] = values[ch] | 0;
        bufRef.current[ch] = next;
      }
    }
    setPath(newPath);
    requestAnimationFrame(draw);
  }, [draw]);

  const toggleRecord = useCallback(() => {
    if (!isRecording) {
      tRef.current = [];
      bufRef.current = Array.from({ length: CHANNELS }, () => new Uint8Array(0));
      setIsRecording(true);
    } else {
      setIsRecording(false);
    }
  }, [isRecording]);

  const saveToFile = useCallback(async () => {
    if (tRef.current.length === 0) return;
    const dialog = (window as any).__TAURI__?.dialog;
    const p = await dialog?.save({ defaultPath: "recording.jsonl", filters: [{ name: "JSON Lines", extensions: ["jsonl"] }] });
    if (!p) return;
    const t0 = tRef.current[0];
    const lines: string[] = [];
    lines.push(JSON.stringify({ format: "artnet-jsonl", version: 1 }));
    for (let i = 0; i < tRef.current.length; i++) {
      const t_ms = tRef.current[i] - t0;
      const values = new Array(CHANNELS);
      for (let ch = 0; ch < CHANNELS; ch++) values[ch] = bufRef.current[ch][i] | 0;
      lines.push(JSON.stringify({ t_ms, net: 0, subnet: 0, universe: 0, length: CHANNELS, values }));
    }
    const content = lines.join("\n") + "\n";
    await invoke("write_text_file", { path: String(p), content });
    setPath(String(p));
  }, []);

  const togglePlay = useCallback(async () => {
    if (!isPlaying) {
      if (!path) { alert("Please load or save a recording to play."); return; }
      setIsPlaying(true);
      await invoke("play_file", { path });
      setIsPlaying(false);
    } else {
      await invoke("stop_playback");
      setIsPlaying(false);
    }
  }, [isPlaying, path]);

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
          <button className="btn" onClick={toggleRecord}>{isRecording ? "Stop" : "Record"}</button>
          <button className="btn" onClick={saveToFile} disabled={tRef.current.length === 0}>Save…</button>
          <button className="btn" onClick={chooseOpen}>Load…</button>
          <button className="btn" onClick={togglePlay}>{isPlaying ? "Stop" : "Play"}</button>
          <span className="status">{path}</span>
        </div>
        <div className="controls-right">
          <button className="iconbtn" title="Player Settings" onClick={() => alert("Player settings coming soon")}>🎛️</button>
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={(e) => { scrollTopRef.current = (e.target as HTMLDivElement).scrollTop; requestAnimationFrame(draw); }}
        style={{ width: "100%", height: "calc(100vh - 220px)", minHeight: 300, borderRadius: 12, overflow: "auto", position: "relative", border: "1px solid var(--glass-border)", background: "var(--glass-bg)", backdropFilter: "var(--blur)" as any }}
      >
        <div style={{ height: CHANNELS * 14 + 16 }} />
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", pointerEvents: "none" }} />
      </div>
    </section>
  );
}
