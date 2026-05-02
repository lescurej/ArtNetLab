import { useState } from "react";
import {
  type DiscoveredNode,
  parseDiscoverExtraIps,
} from "../artdiscover";

interface DiscoverTabProps {
  onApplyTargetIp: (ip: string) => void;
  discoveryIntervalSec: number;
  rows: DiscoveredNode[];
  scanning: boolean;
  error: string | null;
  onScan: (extraBroadcastIps: string[], timeoutMs: number) => void;
}

export default function DiscoverTab({
  onApplyTargetIp,
  discoveryIntervalSec,
  rows,
  scanning,
  error,
  onScan,
}: DiscoverTabProps) {
  const [extraBroadcasts, setExtraBroadcasts] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(2000);

  return (
    <section className="discover-pane">
      <div className="discover-toolbar">
        <button
          type="button"
          className="btn"
          disabled={scanning}
          onClick={() =>
            void onScan(parseDiscoverExtraIps(extraBroadcasts), timeoutMs)
          }
        >
          {scanning ? "Scanning…" : "Scan network"}
        </button>
        <label className="discover-label">
          Extra broadcast IPs
          <input
            type="text"
            className="discover-input"
            placeholder="e.g. 192.168.1.255"
            value={extraBroadcasts}
            onChange={(e) => setExtraBroadcasts(e.currentTarget.value)}
          />
        </label>
        <label className="discover-label">
          Timeout (ms)
          <input
            type="number"
            min={200}
            max={10000}
            step={100}
            className="discover-input discover-input-narrow"
            value={timeoutMs}
            onChange={(e) =>
              setTimeoutMs(Math.max(200, Number(e.currentTarget.value) || 200))
            }
          />
        </label>
        <span className="discover-hint discover-hint-muted">
          {discoveryIntervalSec > 0
            ? `Auto-discovery every ${discoveryIntervalSec}s (change in Monitor or Sender ⚙)`
            : "Auto-discovery off (interval 0 in settings)"}{" "}
          · Targets include interface broadcasts, sender target IP, 255.255.255.255, and extras
          below.
        </span>
      </div>
      {error && <div className="discover-error">{error}</div>}
      <div className="discover-table-wrap">
        <table className="discover-table">
          <thead>
            <tr>
              <th></th>
              <th>IP</th>
              <th>Short name</th>
              <th>Long name</th>
              <th>Firmware</th>
              <th>MAC</th>
              <th>UDP from</th>
              <th>Net/Sub</th>
              <th>ESTA</th>
              <th>OEM</th>
              <th>Ports</th>
              <th>SwOut</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !scanning && (
              <tr>
                <td colSpan={13} className="discover-empty">
                  No nodes yet. Wait for auto-discovery or run a scan.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.ip}-${r.mac}-${r.udpSource}`}>
                <td>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => onApplyTargetIp(r.ip)}
                  >
                    Use IP
                  </button>
                </td>
                <td className="mono">{r.ip}</td>
                <td>{r.shortName || "—"}</td>
                <td className="discover-long">{r.longName || "—"}</td>
                <td className="mono">{r.firmware}</td>
                <td className="mono">{r.mac || "—"}</td>
                <td className="mono discover-small">{r.udpSource}</td>
                <td className="mono">
                  {r.netSwitch}/{r.subSwitch}
                </td>
                <td className="mono">{r.estaCode}</td>
                <td className="mono">{r.oemHex}</td>
                <td className="mono discover-small">{r.numPorts.join("/")}</td>
                <td className="mono discover-small">{r.swoutHex}</td>
                <td className="discover-report" title={r.nodeReport}>
                  {r.nodeReport || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
