import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiscoveredNode } from "./artdiscover";
import "./App.css";
import MonitorCanvas from "./components/MonitorCanvas";
import SenderTab from "./components/SenderTab";
import RecordPlayTab from "./components/RecordPlayTab";
import DiscoverTab from "./components/DiscoverTab";

function App() {
  const [tab, setTab] = useState<
    "monitor" | "sender" | "recplay" | "discover"
  >("monitor");
  const [faders, setFaders] = useState<number[]>(Array(512).fill(0));
  // path handled within RecordPlayTab now
  const [masterValue, setMasterValue] = useState(255);
  const [senderRunning, setSenderRunning] = useState(false);

  // SETTINGS state
  const [showMon, setShowMon] = useState(false);
  const [showSnd, setShowSnd] = useState(false);
  const [monCfg, setMonCfg] = useState({ bind_ip: "0.0.0.0", port: 6454 });
  const [sndCfg, setSndCfg] = useState({
    target_ip: "255.255.255.255",
    port: 6454,
    fps: 44,
    net: 0,
    subnet: 0,
    universe: 0,
  });

  const [discoveryIntervalSec, setDiscoveryIntervalSec] = useState(10);
  const [discoveredNodes, setDiscoveredNodes] = useState<DiscoveredNode[]>([]);
  const [discoveryScanning, setDiscoveryScanning] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const discoveryInFlightRef = useRef(false);

  // Load settings once
  useEffect(() => {
    invoke("load_settings")
      .then((s: any) => {
        if (s?.receiver) setMonCfg(s.receiver);
        if (s?.sender) setSndCfg(s.sender);
        const di = Number(s?.discovery_interval_sec);
        if (Number.isFinite(di)) {
          const v = Math.max(0, Math.min(86400, Math.round(di)));
          setDiscoveryIntervalSec(v);
        }
      })
      .catch((e) => {
        console.error("Failed to load settings:", e);
      });
  }, []);

  const performDiscovery = useCallback(
    async (extraBroadcastIps?: string[], timeoutMs = 2000) => {
      if (discoveryInFlightRef.current) return;
      discoveryInFlightRef.current = true;
      setDiscoveryScanning(true);
      setDiscoveryError(null);
      try {
        const list = await invoke<DiscoveredNode[]>("artnet_discover", {
          cfg: {
            target_ip: sndCfg.target_ip,
            port: sndCfg.port,
            net: sndCfg.net,
            subnet: sndCfg.subnet,
            universe: sndCfg.universe,
            fps: sndCfg.fps,
          },
          extraBroadcastIps:
            extraBroadcastIps?.length ? extraBroadcastIps : null,
          timeoutMs,
        });
        setDiscoveredNodes(list);
      } catch (e) {
        setDiscoveryError(String(e));
      } finally {
        discoveryInFlightRef.current = false;
        setDiscoveryScanning(false);
      }
    },
    [sndCfg]
  );

  useEffect(() => {
    if (discoveryIntervalSec <= 0) return undefined;
    const run = () => void performDiscovery();
    const id = window.setInterval(run, discoveryIntervalSec * 1000);
    run();
    return () => window.clearInterval(id);
  }, [discoveryIntervalSec, performDiscovery]);

  // Auto-start monitor on app open (backend also autostarts; this ensures it runs even if settings aren't loaded yet)
  useEffect(() => {
    (async () => {
      try {
        await invoke("start_receiver");
      } catch {}
    })();
  }, []);

  // MonitorCanvas handles its own event subscription for performance.

  // Monitor runs automatically; no start/stop controls

  // Sender controls
  const startSender = async () => {
    if (senderRunning) {
      await invoke("stop_sender");
      setSenderRunning(false);
    } else {
      await invoke("set_sender_config", { cfg: sndCfg });
      await invoke("start_sender");
      setSenderRunning(true);
    }
  };
  const all = async (v: number) => {
    const arr = new Array(512).fill(v);
    setFaders(arr);

    // Apply master scaling to all values
    const scaledArr = arr.map((value) =>
      Math.round((value * masterValue) / 255)
    );
    await invoke("set_channels_and_push", { values: scaledArr });
  };

  // Update single fader, batch backend update + send
  const sendDebounceRef = useRef<number | null>(null);
  const fadersRef = useRef<number[]>(faders);
  const masterRef = useRef<number>(masterValue);
  useEffect(() => {
    fadersRef.current = faders;
  }, [faders]);
  useEffect(() => {
    masterRef.current = masterValue;
  }, [masterValue]);

  const onFader = useCallback((i: number, v: number) => {
    let nextSnapshot: number[] | null = null;
    setFaders((prev) => {
      if (prev[i] === v) return prev;
      const n = prev.slice();
      n[i] = v;
      nextSnapshot = n;
      fadersRef.current = n;
      return n;
    });
    if (nextSnapshot === null) {
      return Promise.resolve();
    }
    if (sendDebounceRef.current != null) {
      window.clearTimeout(sendDebounceRef.current);
    }
    const snapshotToSend: number[] = nextSnapshot;
    sendDebounceRef.current = window.setTimeout(() => {
      sendDebounceRef.current = null;
      const m = masterRef.current;
      const scaled = snapshotToSend.map((val) => Math.round((val * m) / 255));
      invoke("set_channels_and_push", { values: scaled }).catch(() => {});
    }, 30);
    return Promise.resolve();
  }, []);

  const onMomentaryHold = useCallback((i: number, down: boolean) => {
    if (sendDebounceRef.current != null) {
      window.clearTimeout(sendDebounceRef.current);
      sendDebounceRef.current = null;
    }
    const m = masterRef.current;
    const base = fadersRef.current.slice();
    base[i] = down ? 255 : 0;
    fadersRef.current = base;
    setFaders(base);
    const scaled = base.map((val) => Math.round((val * m) / 255));
    invoke("set_channels_and_push", { values: scaled }).catch(() => {});
  }, []);

  const onInputChange = (i: number, value: string) => {
    const numValue = Number(value);

    if (value === "" || isNaN(numValue)) {
      return;
    }

    const val = Math.max(0, Math.min(255, Math.floor(numValue)));
    onFader(i, val);
  };

  // Settings save
  const saveSettings = async () => {
    await invoke("save_settings", {
      discovery_interval_sec: discoveryIntervalSec,
    });
  };

  // Record/Play
  // Record/Play controls now handled in RecordPlayTab

  const discoveryPicker =
    discoveredNodes.length > 0 ? (
      <div className="discovered-picker">
        <div className="discovered-picker-title">Detected Art-Net nodes</div>
        <ul className="discovered-picker-list">
          {discoveredNodes.map((r) => (
            <li key={`${r.ip}-${r.mac}`}>
              <span title={r.longName}>{r.shortName || r.longName || r.ip}</span>
              <span className="mono discovered-picker-ip">{r.ip}</span>
              <button
                type="button"
                className="btn btn-small"
                onClick={() =>
                  setSndCfg((prev) => ({ ...prev, target_ip: r.ip }))
                }
              >
                Sender target
              </button>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const contentScrollRef = useRef<HTMLElement | null>(null);

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">ArtNetLab</div>
        <nav className="tabs">
          <button
            className={`tab ${tab === "monitor" ? "active" : ""}`}
            onClick={() => setTab("monitor")}
          >
            Monitor
          </button>
          <button
            className={`tab ${tab === "sender" ? "active" : ""}`}
            onClick={() => setTab("sender")}
          >
            Sender
          </button>
          <button
            className={`tab ${tab === "recplay" ? "active" : ""}`}
            onClick={() => setTab("recplay")}
          >
            Record/Play
          </button>
          <button
            className={`tab ${tab === "discover" ? "active" : ""}`}
            onClick={() => setTab("discover")}
          >
            Discover
          </button>
        </nav>
        <div className="spacer" />
        {tab === "monitor" && (
          <button
            className="iconbtn"
            title="Monitor Settings"
            onClick={() => setShowMon(true)}
          >
            ⚙️
          </button>
        )}
        {tab === "sender" && (
          <button
            className="iconbtn"
            title="Sender Settings"
            onClick={() => setShowSnd(true)}
          >
            ⚙️
          </button>
        )}
      </header>

      <main ref={contentScrollRef} className="content">
        {/* Monitor */}
        <section className={`view ${tab === "monitor" ? "active" : ""}`}>
          <MonitorCanvas />
        </section>

        {/* Sender (keep mounted so animation continues when hidden) */}
        <section className={`view ${tab === "sender" ? "active" : ""}`}>
          <SenderTab
            scrollParentRef={contentScrollRef}
            isSenderViewportActive={tab === "sender"}
            faders={faders}
            setFaders={setFaders}
            onFader={onFader}
            onMomentaryHold={onMomentaryHold}
            onInputChange={onInputChange}
            all={all}
            startSender={startSender}
            masterValue={masterValue}
            setMasterValue={setMasterValue}
            senderRunning={senderRunning}
          />
        </section>

        <section className={`view ${tab === "recplay" ? "active" : ""}`}>
          <RecordPlayTab />
        </section>

        <section className={`view ${tab === "discover" ? "active" : ""}`}>
          <DiscoverTab
            onApplyTargetIp={(ip) =>
              setSndCfg((prev) => ({ ...prev, target_ip: ip }))
            }
            discoveryIntervalSec={discoveryIntervalSec}
            rows={discoveredNodes}
            scanning={discoveryScanning}
            error={discoveryError}
            onScan={(extras, tm) => void performDiscovery(extras, tm)}
          />
        </section>
      </main>

      {/* Monitor settings modal */}
      <div
        className={`modal-backdrop ${showMon ? "show" : ""}`}
        onMouseDown={() => setShowMon(false)}
      >
        <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
          <h3>Monitor Settings</h3>
          <div className="row">
            <label>Bind IP</label>
            <input
              value={monCfg.bind_ip}
              onChange={(e) =>
                setMonCfg({ ...monCfg, bind_ip: e.currentTarget.value })
              }
            />
          </div>
          <div className="row">
            <label>Port</label>
            <input
              type="number"
              min={1}
              max={65535}
              value={monCfg.port}
              onChange={(e) =>
                setMonCfg({ ...monCfg, port: Number(e.currentTarget.value) })
              }
            />
          </div>
          <div className="row">
            <label>Discovery interval (sec)</label>
            <input
              type="number"
              min={0}
              max={86400}
              value={discoveryIntervalSec}
              onChange={(e) => {
                const n = Number(e.currentTarget.value);
                const v =
                  Number.isFinite(n)
                    ? Math.max(0, Math.min(86400, Math.round(n)))
                    : 10;
                setDiscoveryIntervalSec(v);
              }}
            />
          </div>
          <p className="field-hint">
            0 turns off periodic ArtPoll scans. Uses current sender broadcast
            list; requires receiver on Art-Net UDP.
          </p>
          {discoveryPicker}
          <div className="actions">
            <button
              className="btn"
              onClick={async () => {
                await invoke("set_receiver_config", { cfg: monCfg });
                await saveSettings();
                setShowMon(false);
              }}
            >
              Save
            </button>
            <button className="btn" onClick={() => setShowMon(false)}>
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Sender settings modal */}
      <div
        className={`modal-backdrop ${showSnd ? "show" : ""}`}
        onMouseDown={() => setShowSnd(false)}
      >
        <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
          <h3>Sender Settings</h3>
          <div className="row">
            <label>Target IP</label>
            <input
              value={sndCfg.target_ip}
              onChange={(e) =>
                setSndCfg({ ...sndCfg, target_ip: e.currentTarget.value })
              }
            />
          </div>
          <div className="row">
            <label>Port</label>
            <input
              type="number"
              min={1}
              max={65535}
              value={sndCfg.port}
              onChange={(e) =>
                setSndCfg({ ...sndCfg, port: Number(e.currentTarget.value) })
              }
            />
          </div>
          <div className="row">
            <label>Frequency (Hz)</label>
            <input
              type="number"
              min={1}
              max={120}
              value={sndCfg.fps}
              onChange={(e) =>
                setSndCfg({ ...sndCfg, fps: Number(e.currentTarget.value) })
              }
            />
          </div>
          <div className="row">
            <label>Net</label>
            <input
              type="number"
              min={0}
              max={127}
              value={sndCfg.net}
              onChange={(e) =>
                setSndCfg({ ...sndCfg, net: Number(e.currentTarget.value) })
              }
            />
          </div>
          <div className="row">
            <label>Subnet</label>
            <input
              type="number"
              min={0}
              max={15}
              value={sndCfg.subnet}
              onChange={(e) =>
                setSndCfg({ ...sndCfg, subnet: Number(e.currentTarget.value) })
              }
            />
          </div>
          <div className="row">
            <label>Universe</label>
            <input
              type="number"
              min={0}
              max={15}
              value={sndCfg.universe}
              onChange={(e) =>
                setSndCfg({
                  ...sndCfg,
                  universe: Number(e.currentTarget.value),
                })
              }
            />
          </div>
          <div className="row">
            <label>Discovery interval (sec)</label>
            <input
              type="number"
              min={0}
              max={86400}
              value={discoveryIntervalSec}
              onChange={(e) => {
                const n = Number(e.currentTarget.value);
                const v =
                  Number.isFinite(n)
                    ? Math.max(0, Math.min(86400, Math.round(n)))
                    : 10;
                setDiscoveryIntervalSec(v);
              }}
            />
          </div>
          <p className="field-hint">
            0 disables auto-discovery (default 10). Same value saved with
            settings.
          </p>
          {discoveryPicker}
          <div className="actions">
            <button
              className="btn"
              onClick={async () => {
                await invoke("set_sender_config", { cfg: sndCfg });
                await saveSettings();
                setShowSnd(false);
              }}
            >
              Save
            </button>
            <button className="btn" onClick={() => setShowSnd(false)}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
