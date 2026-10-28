import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RdmFixture } from "../rdm";
import { universeFieldHint } from "../artnetUniverse";

interface RdmTabProps {
  targetIp: string;
  port: number;
  net: number;
  subnet: number;
  universe: number;
}

export default function RdmTab({
  targetIp,
  port,
  net,
  subnet,
  universe,
}: RdmTabProps) {
  const [portNumber, setPortNumber] = useState(1);
  const [timeoutMs, setTimeoutMs] = useState(8000);
  const [fixtures, setFixtures] = useState<RdmFixture[]>([]);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const senderCfg = {
    target_ip: targetIp,
    port,
    net,
    subnet,
    universe,
    fps: 44,
  };

  const selected = fixtures.find((f) => f.uid === selectedUid) ?? null;

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    setStatus(null);
    try {
      const list = await invoke<RdmFixture[]>("rdm_scan", {
        cfg: senderCfg,
        portIndex: Math.max(0, Math.min(3, portNumber - 1)),
        timeoutMs,
      });
      setFixtures(list);
      if (list.length === 0) {
        setStatus(
          "No RDM devices found. DMX control does not prove RDM — confirm the fixture is RDM-enabled."
        );
        setSelectedUid(null);
      } else if (!list.some((f) => f.uid === selectedUid)) {
        setSelectedUid(list[0].uid);
        setAddressDraft(String(list[0].dmxAddress));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, [targetIp, port, net, subnet, universe, portNumber, timeoutMs, selectedUid]);

  const selectFixture = (f: RdmFixture) => {
    setSelectedUid(f.uid);
    setAddressDraft(String(f.dmxAddress));
    setStatus(null);
  };

  const applyAddress = async () => {
    if (!selected) return;
    const addr = Math.max(1, Math.min(512, Math.floor(Number(addressDraft) || 0)));
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await invoke("rdm_set_dmx_address", {
        cfg: senderCfg,
        portIndex: Math.max(0, Math.min(3, portNumber - 1)),
        uid: selected.uid,
        address: addr,
      });
      setFixtures((prev) =>
        prev.map((f) =>
          f.uid === selected.uid ? { ...f, dmxAddress: addr } : f
        )
      );
      setAddressDraft(String(addr));
      setStatus(`DMX start address set to ${addr} for ${selected.uid}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleIdentify = async (on: boolean) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("rdm_identify", {
        cfg: senderCfg,
        portIndex: Math.max(0, Math.min(3, portNumber - 1)),
        uid: selected.uid,
        on,
      });
      setStatus(on ? "Identify on." : "Identify off.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="discover-pane rdm-pane">
      <div className="discover-toolbar">
        <button
          type="button"
          className="btn"
          disabled={scanning || busy}
          onClick={() => void runScan()}
        >
          {scanning ? "Scanning…" : "Scan RDM line"}
        </button>
        <label className="discover-label">
          DMX port (1–4)
          <input
            type="number"
            min={1}
            max={4}
            className="discover-input discover-input-narrow"
            value={portNumber}
            onChange={(e) =>
              setPortNumber(Math.max(1, Math.min(4, Number(e.currentTarget.value) || 1)))
            }
          />
        </label>
        <label className="discover-label">
          Timeout (ms)
          <input
            type="number"
            min={1500}
            max={30000}
            step={500}
            className="discover-input discover-input-narrow"
            value={timeoutMs}
            onChange={(e) =>
              setTimeoutMs(
                Math.max(1500, Number(e.currentTarget.value) || 5000)
              )
            }
          />
        </label>
        <span className="discover-hint discover-hint-muted">
          Gateway: <span className="mono">{targetIp || "—"}</span> · same universe as
          Sender ⚙: <strong>{net}/{subnet}/{universe}</strong>. {universeFieldHint(universe)}
          Scan tries alternate universes when the gateway maps ports differently.
        </span>
      </div>
      {error && <div className="discover-error">{error}</div>}
      {status && !error && <div className="rdm-status">{status}</div>}

      <div className="rdm-layout">
        <div className="discover-table-wrap rdm-table-wrap">
          <table className="discover-table">
            <thead>
              <tr>
                <th>UID</th>
                <th>Model</th>
                <th>DMX addr</th>
                <th>Footprint</th>
                <th>Personality</th>
              </tr>
            </thead>
            <tbody>
              {fixtures.length === 0 && !scanning && (
                <tr>
                  <td colSpan={5} className="discover-empty">
                    No fixtures. Run a scan with an Art-Net node on the RDM
                    universe.
                  </td>
                </tr>
              )}
              {fixtures.map((f) => (
                <tr
                  key={f.uid}
                  className={f.uid === selectedUid ? "rdm-row-selected" : ""}
                  onClick={() => selectFixture(f)}
                >
                  <td className="mono">{f.uid}</td>
                  <td className="mono">0x{f.modelId.toString(16).padStart(4, "0")}</td>
                  <td className="mono">{f.dmxAddress}</td>
                  <td className="mono">{f.footprint}</td>
                  <td className="mono">{f.personality}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="rdm-config">
          <h3 className="rdm-config-title">Fixture</h3>
          {!selected ? (
            <p className="discover-hint">Select a device to configure.</p>
          ) : (
            <>
              <div className="rdm-field">
                <span className="rdm-field-label">UID</span>
                <span className="mono">{selected.uid}</span>
              </div>
              <div className="rdm-field">
                <span className="rdm-field-label">Sub-devices</span>
                <span className="mono">{selected.subDeviceCount}</span>
              </div>
              <label className="discover-label">
                DMX start address
                <input
                  type="number"
                  min={1}
                  max={512}
                  className="discover-input discover-input-narrow"
                  value={addressDraft}
                  onChange={(e) => setAddressDraft(e.currentTarget.value)}
                  disabled={busy}
                />
              </label>
              <div className="rdm-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void applyAddress()}
                >
                  Apply address
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => void toggleIdentify(true)}
                >
                  Identify on
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => void toggleIdentify(false)}
                >
                  Identify off
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
