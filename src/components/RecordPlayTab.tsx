import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type PreviewPoint = {
  t_ms: number;
  value: number;
};

type PreviewResponse = {
  points: PreviewPoint[];
  frame_count: number;
  duration_ms: number;
};

type LoadedRecording = {
  path: string;
  channels: number[];
  frames: number;
  duration_ms: number;
  last_address?: number[] | null;
  format: string;
};

type SenderConfig = {
  target_ip: string;
  port: number;
  fps: number;
  net: number;
  subnet: number;
  universe: number;
};

const PREVIEW_POINTS = 1200;
const CHANNEL_LIMIT = 512;

function parseChannels(text: string): number[] {
  const parts = text
    .split(/[\,\s]+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= CHANNEL_LIMIT);
  const unique: number[] = [];
  for (const ch of parts) {
    if (!unique.includes(ch)) unique.push(ch);
  }
  return unique;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0.00 s";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}m ${remaining.toFixed(1)}s`;
}

export default function RecordPlayTab() {
  const [universes, setUniverses] = useState<UniverseKey[]>([]);
  const [selected, setSelected] = useState<UniverseKey>("");
  const universeLastSeenRef = useRef<Map<UniverseKey, number>>(new Map());
  const [blink, setBlink] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [recordingFormat, setRecordingFormat] = useState<"jsonl" | "wav">(
    "jsonl"
  );
  const [channelsText, setChannelsText] = useState("1");
  const [recordChannels, setRecordChannels] = useState<number[]>([1]);
  const [selectedChannel, setSelectedChannel] = useState<number>(1);
  const [path, setPath] = useState<string>("");

  const [preview, setPreview] = useState<PreviewPoint[]>([]);
  const previewRef = useRef<PreviewPoint[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<number | null>(null);
  const [summary, setSummary] = useState<{ frames: number; duration_ms: number }>(
    { frames: 0, duration_ms: 0 }
  );

  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<SenderConfig | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.floor(width * dpr));
    const ch = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "rgba(10, 16, 24, 0.85)";
    ctx.fillRect(0, 0, width, height);

    const padding = 28;
    const plotWidth = Math.max(1, width - padding * 2);
    const plotHeight = Math.max(1, height - padding * 2);

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, height - padding);
    ctx.lineTo(width - padding, height - padding);
    ctx.stroke();

    const points = previewRef.current;
    if (!points || points.length === 0) {
      ctx.fillStyle = "#9fb3c8";
      ctx.font = "12px Inter, system-ui, -apple-system";
      ctx.fillText("No recorded data", padding, padding + 14);
      return;
    }

    const first = points[0].t_ms;
    const last = points[points.length - 1].t_ms;
    const span = Math.max(1, last - first);

    ctx.strokeStyle = "#5ab0ff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    points.forEach((pt, index) => {
      const x = padding + ((pt.t_ms - first) / span) * plotWidth;
      const y = padding + (1 - pt.value / 255) * plotHeight;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }, []);

  useEffect(() => {
    previewRef.current = preview;
    draw();
  }, [preview, draw]);

  useEffect(() => {
    const observer = new ResizeObserver(() => draw());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [draw]);

  const fetchPreview = useCallback(async () => {
    if (!selectedChannel) {
      setPreview([]);
      setSummary({ frames: 0, duration_ms: 0 });
      return;
    }
    try {
      const response = (await invoke("get_recording_preview", {
        channel: selectedChannel,
        maxPoints: PREVIEW_POINTS,
      })) as PreviewResponse;
      setPreview(response.points || []);
      setSummary({
        frames: response.frame_count || 0,
        duration_ms: response.duration_ms || 0,
      });
    } catch (err) {
      console.error("Failed to fetch preview", err);
    }
  }, [selectedChannel]);

  useEffect(() => {
    fetchPreview();
  }, [fetchPreview]);

  useEffect(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (isRecording) {
      pollRef.current = window.setInterval(() => {
        fetchPreview();
      }, 250);
    }
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isRecording, fetchPreview]);

  useEffect(() => {
    (async () => {
      try {
        const initial = (await invoke("set_record_channels", {
          channels: [1],
        })) as number[];
        if (initial.length > 0) {
          setRecordChannels(initial);
          setChannelsText(initial.join(","));
          setSelectedChannel(initial[0]);
        }
      } catch (err) {
        console.error("Failed to initialise record channels", err);
      }
    })();
  }, []);

  const updateChannels = useCallback(
    async (text: string) => {
      setChannelsText(text);
      const parsed = parseChannels(text);
      if (parsed.length === 0) {
        setRecordChannels([]);
        setSelectedChannel(0);
        await invoke("set_record_channels", { channels: [] });
        setPreview([]);
        setSummary({ frames: 0, duration_ms: 0 });
        return;
      }
      try {
        const result = (await invoke("set_record_channels", {
          channels: parsed,
        })) as number[];
        if (result.length > 0) {
          setRecordChannels(result);
          if (!result.includes(selectedChannel)) {
            setSelectedChannel(result[0]);
          }
        }
      } catch (err) {
        console.error("Failed to set record channels", err);
      }
    },
    [selectedChannel]
  );

  const toggleRecord = useCallback(async () => {
    if (!isRecording) {
      try {
        const result = (await invoke("start_buffered_recording", {
          channels: recordChannels.length > 0 ? recordChannels : [1],
        })) as number[];
        if (result.length > 0) {
          setRecordChannels(result);
          setChannelsText(result.join(","));
          if (!result.includes(selectedChannel)) {
            setSelectedChannel(result[0]);
          }
        }
        setIsRecording(true);
        setPath("");
        setSummary({ frames: 0, duration_ms: 0 });
      } catch (err) {
        console.error("Failed to start recording", err);
      }
    } else {
      try {
        await invoke("stop_buffered_recording");
      } finally {
        setIsRecording(false);
        fetchPreview();
      }
    }
  }, [isRecording, recordChannels, selectedChannel, fetchPreview]);

  const clearBuffer = useCallback(async () => {
    await invoke("clear_record_buffer");
    setPreview([]);
    setSummary({ frames: 0, duration_ms: 0 });
    setPath("");
  }, []);

  const saveToFile = useCallback(async () => {
    if (summary.frames === 0) return;
    const extension = recordingFormat === "wav" ? "wav" : "jsonl";
    const file = await dialogSave({
      defaultPath: `recording.${extension}`,
      filters: [
        { name: "ArtNet JSONL", extensions: ["jsonl"] },
        { name: "ArtNet WAV", extensions: ["wav"] },
      ],
    });
    if (!file) return;
    try {
      if (recordingFormat === "wav") {
        await invoke("save_buffered_recording_wav", { path: String(file) });
      } else {
        await invoke("save_buffered_recording_jsonl", { path: String(file) });
      }
      setPath(String(file));
    } catch (err) {
      console.error("Failed to save recording", err);
      alert("Failed to save recording. Check console for details.");
    }
  }, [recordingFormat, summary.frames]);

  const chooseOpen = useCallback(async () => {
    const file = await dialogOpen({
      multiple: false,
      filters: [
        { name: "ArtNet Files", extensions: ["jsonl", "json", "wav"] },
        { name: "ArtNet JSONL", extensions: ["jsonl", "json"] },
        { name: "ArtNet WAV", extensions: ["wav"] },
      ],
    });
    if (!file) return;
    if (
      summary.frames > 0 &&
      !window.confirm("Discard current in-memory recording and load file?")
    )
      return;
    try {
      const result = (await invoke("load_recording", {
        path: String(file),
      })) as LoadedRecording;
      setRecordChannels(result.channels);
      setChannelsText(result.channels.join(","));
      setSelectedChannel(
        result.channels.includes(selectedChannel)
          ? selectedChannel
          : result.channels[0] || 0
      );
      setSummary({ frames: result.frames, duration_ms: result.duration_ms });
      setPath(result.path);
      if (result.last_address && result.last_address.length === 3) {
        const key = result.last_address.join("/");
        setUniverses((prev) => (prev.includes(key) ? prev : [...prev, key]));
        setSelected((prev) => prev || key);
      }
      fetchPreview();
    } catch (err) {
      console.error("Failed to load recording", err);
      alert("Failed to load recording. Check console for details.");
    }
  }, [summary.frames, selectedChannel, fetchPreview]);

  const togglePlay = useCallback(async () => {
    if (!isPlaying) {
      if (!path) {
        alert("Please save or load a recording before playback.");
        return;
      }
      setIsPlaying(true);
      try {
        if (path.toLowerCase().endsWith(".wav")) {
          await invoke("play_wav_file", { path });
        } else {
          await invoke("play_file", { path });
        }
      } catch (err) {
        console.error("Failed to start playback", err);
        setIsPlaying(false);
      }
    } else {
      await invoke("stop_playback");
      setIsPlaying(false);
    }
  }, [isPlaying, path]);

  const openSettings = useCallback(async () => {
    try {
      const cfg = (await invoke("get_sender_config")) as SenderConfig;
      setSettings(cfg);
    } catch (err) {
      setSettings({
        target_ip: "255.255.255.255",
        port: 6454,
        fps: 44,
        net: 0,
        subnet: 0,
        universe: 0,
      });
      console.error("Failed to load sender config", err);
    }
    setShowSettings(true);
  }, []);

  const saveSettings = useCallback(async () => {
    if (!settings) return;
    await invoke("set_sender_config", { cfg: settings });
    await invoke("save_settings").catch(() => {});
    setShowSettings(false);
  }, [settings]);

  useEffect(() => {
    let unlisten: Promise<UnlistenFn> | null = null;
    unlisten = listen<Frame>("artnet:dmx_filtered", (event) => {
      const payload = event.payload;
      if (!payload) return;
      const key: UniverseKey = `${payload.net}/${payload.subnet}/${payload.universe}`;
      const now = Date.now();
      universeLastSeenRef.current.set(key, now);
      setUniverses((prev) => (prev.includes(key) ? prev : [...prev, key]));
      if (!selected) setSelected(key);
    });
    return () => {
      unlisten?.then((fn) => fn());
    };
  }, [selected]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setUniverses((prev) => {
        const keep = prev.filter((key) => {
          const last = universeLastSeenRef.current.get(key) || 0;
          return now - last <= 10000;
        });
        if (keep.length && selected && !keep.includes(selected)) {
          setSelected(keep[0]);
        }
        return keep;
      });
      if (selected) {
        const last = universeLastSeenRef.current.get(selected) || 0;
        const active = now - last < 300;
        setBlink((prev) => (active ? !prev : false));
      } else {
        setBlink(false);
      }
    }, 300);
    return () => window.clearInterval(id);
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const [net, subnet, universe] = selected
      .split("/")
      .map((part) => Number(part) || 0);
    invoke("set_event_filter", {
      filter: { net, subnet, universe },
    });
    return () => {
      invoke("set_event_filter", { filter: null });
    };
  }, [selected]);

  const channelOptions = useMemo(() => {
    return recordChannels.map((ch) => (
      <option key={ch} value={ch}>
        {ch}
      </option>
    ));
  }, [recordChannels]);

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
          <label className="animation-label">Channels:</label>
          <input
            type="text"
            value={channelsText}
            onChange={(e) => updateChannels(e.target.value)}
            className="freq-input"
          />
          <label className="animation-label">Preview channel:</label>
          <select
            value={selectedChannel || ""}
            onChange={(e) => setSelectedChannel(Number(e.target.value) || 0)}
            className="animation-select"
            disabled={recordChannels.length === 0}
          >
            {recordChannels.length === 0 && <option value="">None</option>}
            {channelOptions}
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
            disabled={summary.frames === 0 && !isRecording}
          >
            Clear
          </button>
          <button
            className="btn"
            onClick={saveToFile}
            disabled={summary.frames === 0}
          >
            Save…
          </button>
          <button className="btn" onClick={chooseOpen}>
            Load…
          </button>
          <button className="btn" onClick={togglePlay}>
            {isPlaying ? "Stop" : "Play"}
          </button>
          <span className="status">
            {path}
            {summary.frames > 0 && (
              <>
                {path ? " • " : ""}
                {summary.frames} frames · {formatDuration(summary.duration_ms)}
              </>
            )}
          </span>
        </div>
        <div className="controls-right">
          <button className="iconbtn" title="Player Settings" onClick={openSettings}>
            🎛️
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "calc(100vh - 220px)",
          minHeight: 320,
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid var(--glass-border)",
          background: "var(--glass-bg)",
          backdropFilter: "var(--blur)" as any,
          position: "relative",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
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
