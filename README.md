# ArtNetLab

ArtNetLab is a Tauri (Rust) desktop app that provides two core tools:

- Art-Net Monitor: real-time view of incoming ArtDMX values (0–511).
- Art-Net Sender: 512 vertical faders to control a universe. Default send rate 44 Hz (configurable).

- Record/Play: capture incoming ArtDMX to a JSON Lines file and play it back.

Each tab has a settings dialog to configure IP/port (monitor) and target IP/port/net/subnet/universe/frequency (sender). Settings persist locally.

---

## Build & Run

Prereqs: Rust stable, Tauri CLI 2.x.

macOS/Linux

```bash
# inside the repo root
cargo tauri dev
```

Release build

```bash
cargo tauri build
```

The app serves static UI from `ui/` (no Node or npm needed).

---

## Usage

- Monitor tab
  - Open settings (gear) to set bind IP and port (default 0.0.0.0:6454).
  - Click “Start Monitor”. Cells reflect channel intensity and value.

- Sender tab
  - Open settings (knobs) to set target IP/port and addressing (net/subnet/universe) and Frequency (Hz).
  - Move faders; changes are throttled and sent as ArtDMX frames at your configured rate.
  - Use “All 0” / “All 255” for quick tests.

- Record/Play tab
  - Record to...: choose a file to write JSON Lines (.jsonl). First line is a header, then one frame per line: { t_ms, net, subnet, universe, length, values }.
  - Open File: pick an existing .jsonl recording.
  - Play: replays with original timing to your current Sender target (per-frame net/subnet/universe is preserved).
  - Stop Rec / Stop Play: end recording or playback.

Notes

- Default port is 6454. Sender defaults to broadcast 255.255.255.255.
- Universe addressing follows Art-Net: SubUni = (subnet << 4) | universe; Net is separate.
- The sender runs at a configurable frequency (default 44 Hz).

---

## Structure

- `src-tauri/` Rust backend: UDP Art-Net send/receive and Tauri commands.
- `ui/` static frontend: vanilla HTML/CSS/JS.
- `tauri.conf.json` Tauri v2 config with global Tauri API enabled and dialog plugin.

---

## Security & Networking

Art-Net uses UDP broadcast by default. Ensure your OS firewall allows UDP/6454 for your network interface. For unicast, set the Sender target IP to the device address.
