import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import MonitorCanvas from "./components/MonitorCanvas";
import SenderTab from "./components/SenderTab";
import RecordPlayTab from "./components/RecordPlayTab";

function App() {
  const [tab, setTab] = useState<"monitor" | "sender" | "recplay">("monitor");
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

  // Load settings once
  useEffect(() => {
    invoke("load_settings")
      .then((s: any) => {
        console.log("Loaded settings:", s);
        if (s?.receiver) {
          console.log("Setting receiver config:", s.receiver);
          setMonCfg(s.receiver);
        }
        if (s?.sender) {
          console.log("Setting sender config:", s.sender);
          setSndCfg(s.sender);
        }
      })
      .catch((e) => {
        console.error("Failed to load settings:", e);
      });
  }, []);

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
  const sendNow = async () => {
    await invoke("push_frame");
  };
  const all = async (v: number) => {
    const arr = new Array(512).fill(v);
    setFaders(arr);

    // Apply master scaling to all values
    const scaledArr = arr.map((value) =>
      Math.round((value * masterValue) / 255)
    );
    await invoke("set_channels", { values: scaledArr });
    await sendNow();
  };

  // Update single fader, batch backend update + send
  const [sendTimer, setSendTimer] = useState<number | null>(null);
  const fadersRef = useRef<number[]>(faders);
  const masterRef = useRef<number>(masterValue);
  useEffect(() => {
    fadersRef.current = faders;
  }, [faders]);
  useEffect(() => {
    masterRef.current = masterValue;
  }, [masterValue]);

  const onFader = useCallback(
    (i: number, v: number) => {
      setFaders((prev) => {
        if (prev[i] === v) return prev;
        const n = prev.slice();
        n[i] = v;
        return n;
      });
      if (sendTimer) return Promise.resolve();
      const id = window.setTimeout(() => {
        setSendTimer(null);
        const src = fadersRef.current;
        const m = masterRef.current;
        const scaled = src.map((val) => Math.round((val * m) / 255));
        invoke("set_channels", { values: scaled }).catch(() => {});
        invoke("push_frame").catch(() => {});
      }, 30);
      setSendTimer(id);
      return Promise.resolve();
    },
    [sendTimer]
  );

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
    await invoke("save_settings");
  };

  // Record/Play
  // Record/Play controls now handled in RecordPlayTab

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

      <main className="content">
        {/* Monitor */}
        <section className={`view ${tab === "monitor" ? "active" : ""}`}>
          <MonitorCanvas />
        </section>

        {/* Sender (keep mounted so animation continues when hidden) */}
        <section className={`view ${tab === "sender" ? "active" : ""}`}>
          <SenderTab
            faders={faders}
            setFaders={setFaders}
            onFader={onFader}
            onInputChange={onInputChange}
            all={all}
            startSender={startSender}
            masterValue={masterValue}
            setMasterValue={setMasterValue}
            senderRunning={senderRunning}
          />
        </section>

        {/* Record/Play */}
        <section className={`view ${tab === "recplay" ? "active" : ""}`}>
          <RecordPlayTab />
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
