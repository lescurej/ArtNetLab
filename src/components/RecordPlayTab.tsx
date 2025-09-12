import { useCallback, useEffect, useRef, useState } from "react";
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

interface RecordPlayTabProps {}

const CHANNELS = 512;
const CELL_H = 24; // larger rows for readability
const GUTTER_W = 48; // left gutter for channel number

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
  const [recordingFormat, setRecordingFormat] = useState<"jsonl" | "wav">(
    "jsonl"
  );

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

  const MAX_VIZ_FRAMES = 2000; // Keep visualization smooth (45 seconds)
  const SAMPLE_RATE = 10; // Sample every 10th frame for visualization
  const MAX_COMPLETE_FRAMES = 200000; // Allow 1+ hours of complete data

  // Canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);

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

    if (canvas.width !== CW || canvas.height !== CH) {
      canvas.width = CW;
      canvas.height = CH;
    }

    // scale for crisp rendering
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background glass panel
    ctx.fillStyle = "rgba(10, 16, 24, 0.85)";
    ctx.fillRect(0, 0, W, H);

    const pad = 8;
    const cellH = CELL_H;
    const xs = tRef.current.length;
    if (xs === 0) {
      ctx.fillStyle = "#9fb3c8";
      ctx.font = "12px Inter, system-ui, -apple-system";
      ctx.fillText(
        "Waiting for data… (Record to capture to file)",
        pad,
        pad + 14
      );
      return;
    }

    // Mapping time to X
    const t0 = tRef.current[0];
    const tN = tRef.current[xs - 1];
    const span = Math.max(1, tN - t0);

    // Virtualize vertically: draw only visible rows
    const scrollTop = scrollTopRef.current;
    const startRow = Math.max(0, Math.floor(scrollTop / cellH));
    const endRow = Math.min(CHANNELS - 1, Math.floor((scrollTop + H) / cellH));

    ctx.lineWidth = 1.2;
    for (let ch = startRow; ch <= endRow; ch++) {
      const y0 = ch * cellH - scrollTop; // Remove pad offset
      const ih = cellH - 6;
      const x0 = pad + GUTTER_W;
      const iw = W - pad * 2 - GUTTER_W;

      // row background and separator
      ctx.fillStyle =
        ch % 2 === 0 ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.03)";
      ctx.fillRect(pad, y0, W - pad * 2, ih + 6);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(pad, y0 + ih + 5.5);
      ctx.lineTo(W - pad, y0 + ih + 5.5);
      ctx.stroke();

      // channel number in gutter
      ctx.fillStyle = "#9fb3c8";
      ctx.font = "12px Inter, system-ui, -apple-system";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(String(ch + 1), pad + GUTTER_W - 8, y0 + (ih + 6) / 2);

      // Trace downsampled per pixel
      const vals = vizBufRef.current[ch];
      if (!vals || vals.length === 0) continue;
      ctx.beginPath();
      let first = true;
      for (let px = 0; px < iw; px++) {
        const tt = vizTRef.current[0] + (span * px) / Math.max(1, iw - 1);
        let idx = Math.floor(
          ((tt - vizTRef.current[0]) / span) * (vizTRef.current.length - 1)
        );
        if (idx < 0) idx = 0;
        if (idx >= vizTRef.current.length) idx = vizTRef.current.length - 1;
        const v = vals[idx] || 0;
        const y = y0 + (ih - 1) * (1 - v / 255);
        const x = x0 + px;
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = "#5ab0ff";
      ctx.stroke();
    }
  }, []);

  // Universe discovery and data capture
  useEffect(() => {
    let unlisten: Promise<UnlistenFn> | null = null;
    unlisten = listen<Frame>("artnet:dmx_filtered", (e) => {
      const p = e.payload;
      if (!p) return;
      const key: UniverseKey = `${p.net}/${p.subnet}/${p.universe}`;
      const now = Date.now();
      universeLastSeenRef.current.set(key, now);
      setUniverses((prev) => (prev.includes(key) ? prev : [...prev, key]));
      if (!selected) setSelected(key);

      // Append snapshot only while recording
      if (isRecording) {
        const values = p.values || [];
        const now = Date.now();

        // Always save complete data
        tRef.current.push(now);
        for (let ch = 0; ch < CHANNELS; ch++) {
          const v = values[ch] | 0;
          const prev = bufRef.current[ch];
          const next = new Uint8Array(prev.length + 1);
          if (prev.length) next.set(prev, 0);
          next[prev.length] = v;
          bufRef.current[ch] = next;
        }

        // Downsample for visualization
        const shouldSample =
          vizTRef.current.length === 0 ||
          tRef.current.length - vizTRef.current.length >= SAMPLE_RATE;

        if (shouldSample) {
          vizTRef.current.push(now);
          for (let ch = 0; ch < CHANNELS; ch++) {
            const v = values[ch] | 0;
            const prev = vizBufRef.current[ch];
            const next = new Uint8Array(prev.length + 1);
            if (prev.length) next.set(prev, 0);
            next[prev.length] = v;
            vizBufRef.current[ch] = next;
          }
        }

        // Cleanup visualization data if it gets too large
        if (vizTRef.current.length > MAX_VIZ_FRAMES) {
          const keep = Math.floor(MAX_VIZ_FRAMES * 0.8);
          vizTRef.current = vizTRef.current.slice(-keep);
          for (let ch = 0; ch < CHANNELS; ch++) {
            vizBufRef.current[ch] = vizBufRef.current[ch].slice(-keep);
          }
        }

        // Cleanup complete data if it gets too large (keep last 2 hours)
        if (tRef.current.length > MAX_COMPLETE_FRAMES) {
          const keep = Math.floor(MAX_COMPLETE_FRAMES * 0.5); // Keep last 1 hour
          tRef.current = tRef.current.slice(-keep);
          for (let ch = 0; ch < CHANNELS; ch++) {
            bufRef.current[ch] = bufRef.current[ch].slice(-keep);
          }
        }
      }
      // Use setTimeout instead of requestAnimationFrame for background updates
      setTimeout(() => requestAnimationFrame(draw), 0);
    });
    return () => {
      unlisten?.then((fn) => fn());
    };
  }, [isRecording, selected, draw]);

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
      const r = containerRef.current.getBoundingClientRect();
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
    // Detect file format and load accordingly
    const isWavFile = newPath.toLowerCase().endsWith(".wav");

    if (isWavFile) {
      // Load WAV file
      const wavData = (await invoke("load_wav_recording", {
        path: newPath,
      })) as any;

      console.log("Loaded WAV file with", wavData.timestamps.length, "frames");

      // Populate buffers from WAV data
      tRef.current = wavData.timestamps;
      for (let ch = 0; ch < CHANNELS; ch++) {
        bufRef.current[ch] = new Uint8Array(wavData.channels[ch] || []);
      }
    } else {
      // Load JSONL file
      const content = (await invoke("read_text_file", {
        path: newPath,
      })) as string;
      console.log("Loaded file content length:", content.length);

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
      const lines = content.split(/\r?\n/).filter(Boolean);
      let i = 0;
      if (
        lines[0] &&
        lines[0].includes("format") &&
        lines[0].includes("artnet-jsonl")
      )
        i = 1;
      let loadedKey: UniverseKey | "" = "";
      for (; i < lines.length; i++) {
        const obj = JSON.parse(lines[i]);
        const t_ms = obj.t_ms as number;
        const values = obj.values as number[];
        if (!loadedKey && obj && typeof obj.net === "number") {
          loadedKey = `${obj.net | 0}/${obj.subnet | 0}/${obj.universe | 0}`;
        }
        tRef.current.push(t_ms);
        for (let ch = 0; ch < CHANNELS; ch++) {
          const prev = bufRef.current[ch];
          const next = new Uint8Array(prev.length + 1);
          if (prev.length) next.set(prev, 0);
          next[prev.length] = values[ch] | 0;
          bufRef.current[ch] = next;
        }
      }
    }

    // Populate visualization buffer from loaded data
    if (tRef.current.length > 0) {
      vizTRef.current = [];
      for (let ch = 0; ch < CHANNELS; ch++) {
        vizBufRef.current[ch] = new Uint8Array(0);
      }

      // Downsample the loaded data for visualization
      const sampleRate = Math.max(
        1,
        Math.floor(tRef.current.length / MAX_VIZ_FRAMES)
      );
      for (let i = 0; i < tRef.current.length; i += sampleRate) {
        vizTRef.current.push(tRef.current[i]);
        for (let ch = 0; ch < CHANNELS; ch++) {
          const v = bufRef.current[ch][i] || 0;
          const prev = vizBufRef.current[ch];
          const next = new Uint8Array(prev.length + 1);
          if (prev.length) next.set(prev, 0);
          next[prev.length] = v;
          vizBufRef.current[ch] = next;
        }
      }
    }

    if (loadedKey) {
      setUniverses((prev) =>
        prev.includes(loadedKey) ? prev : [...prev, loadedKey]
      );
      setSelected((prev) => prev || loadedKey);
    }
    setPath(newPath);
    requestAnimationFrame(draw);
  }, [draw]);

  const toggleRecord = useCallback(() => {
    if (!isRecording) {
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
      setIsRecording(false);
    }
  }, [isRecording]);

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
          channels: Array.from({ length: CHANNELS }, (_, ch) =>
            Array.from(bufRef.current[ch])
          ),
        },
      });
    } else {
      // Save as JSONL format
      const t0 = tRef.current[0];
      const lines: string[] = [];
      lines.push(JSON.stringify({ format: "artnet-jsonl", version: 1 }));
      for (let i = 0; i < tRef.current.length; i++) {
        const t_ms = tRef.current[i] - t0;
        const values = new Array(CHANNELS);
        for (let ch = 0; ch < CHANNELS; ch++)
          values[ch] = bufRef.current[ch][i] | 0;
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
            length: CHANNELS,
            values,
          })
        );
      }
      const content = lines.join("\n") + "\n";
      await invoke("write_text_file", { path: String(p), content });
    }

    setPath(String(p));
  }, [selected, recordingFormat]);

  const togglePlay = useCallback(async () => {
    if (!isPlaying) {
      if (!path) {
        alert("Please load or save a recording to play.");
        return;
      }
      setIsPlaying(true);

      // Detect format and play accordingly
      const isWavFile = path.toLowerCase().endsWith(".wav");
      if (isWavFile) {
        await invoke("play_wav_file", { path });
      } else {
        await invoke("play_file", { path });
      }
    } else {
      await invoke("stop_playback");
      setIsPlaying(false);
    }
  }, [isPlaying, path]);

  const clearBuffer = useCallback(() => {
    tRef.current = [];
    bufRef.current = Array.from({ length: CHANNELS }, () => new Uint8Array(0));
    vizTRef.current = [];
    vizBufRef.current = Array.from(
      { length: CHANNELS },
      () => new Uint8Array(0)
    );
    requestAnimationFrame(draw);
  }, [draw]);

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
          <span
            title={blink ? "DMX activity" : "No recent frames"}
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              marginLeft: 8,
              borderRadius: 6,
              background: blink ? "#2da8ff" : "#244860",
              boxShadow: blink ? "0 0 8px rgba(45,168,255,0.9)" : "none",
              transition: "background 0.1s",
            }}
          />
          <button className="btn" onClick={toggleRecord}>
            {isRecording ? "Stop" : "Record"}
          </button>
          <button
            className="btn"
            onClick={clearBuffer}
            disabled={tRef.current.length === 0 && !isRecording}
            title="Clear captured buffer"
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
          <span className="status">{path}</span>
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
      <div
        ref={containerRef}
        onScroll={(e) => {
          scrollTopRef.current = (e.target as HTMLDivElement).scrollTop;
          // Use setTimeout to ensure updates continue in background
          setTimeout(() => requestAnimationFrame(draw), 0);
        }}
        style={{
          width: "100%",
          height: "calc(100vh - 220px)",
          minHeight: 360,
          borderRadius: 12,
          overflowY: "auto",
          position: "relative",
          border: "1px solid var(--glass-border)",
          background: "var(--glass-bg)",
          backdropFilter: "var(--blur)" as any,
        }}
      >
        <div style={{ height: CHANNELS * CELL_H }}>
          {(() => {
            const scrollTop = scrollTopRef.current;
            const containerHeight = containerRef.current?.clientHeight || 360;
            const startRow = Math.max(0, Math.floor(scrollTop / CELL_H) - 5);
            const endRow = Math.min(
              CHANNELS - 1,
              Math.ceil((scrollTop + containerHeight) / CELL_H) + 5
            );

            return Array.from({ length: endRow - startRow + 1 }, (_, i) => {
              const ch = startRow + i;
              const vals = vizBufRef.current[ch]; // Use visualization data
              const hasData = vals && vals.length > 0;

              return (
                <div
                  key={ch}
                  style={{
                    position: "absolute",
                    top: ch * CELL_H,
                    left: 0,
                    right: 0,
                    height: CELL_H,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 8px",
                    borderBottom: "1px solid rgba(255,255,255,0.08)",
                    background:
                      ch % 2 === 0
                        ? "rgba(255,255,255,0.02)"
                        : "rgba(255,255,255,0.03)",
                  }}
                >
                  <div
                    style={{
                      width: GUTTER_W - 8,
                      textAlign: "right",
                      color: "#9fb3c8",
                      fontSize: "12px",
                      fontFamily: "Inter, system-ui, -apple-system",
                    }}
                  >
                    {ch + 1}
                  </div>
                  <div
                    style={{
                      flex: 1,
                      height: CELL_H - 6,
                      position: "relative",
                      background: "transparent",
                    }}
                  >
                    {hasData && (
                      <svg
                        width="100%"
                        height="100%"
                        style={{ display: "block" }}
                        viewBox={`0 0 ${
                          containerRef.current?.clientWidth || 800
                        } ${CELL_H - 6}`}
                        preserveAspectRatio="none"
                      >
                        <polyline
                          points={Array.from(vals)
                            .map((v, i) => {
                              const x =
                                (i / (vals.length - 1)) *
                                (containerRef.current?.clientWidth || 800);
                              const y = (CELL_H - 6) * (1 - v / 255);
                              return `${x},${y}`;
                            })
                            .join(" ")}
                          fill="none"
                          stroke="#5ab0ff"
                          strokeWidth="1.2"
                        />
                      </svg>
                    )}
                  </div>
                </div>
              );
            });
          })()}
        </div>
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
