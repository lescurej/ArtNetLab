# ArtNetLab

ArtNetLab is a modern Tauri (Rust) desktop application for professional DMX lighting control and monitoring. Built with React and TypeScript frontend and Rust backend, it provides comprehensive Art-Net tools for lighting professionals.

## Features

### 🎛️ Art-Net Sender
- **512 Individual Faders**: Full DMX universe control with vertical sliders
- **Dual Input Methods**: 
  - Custom vertical sliders with smooth dragging
  - Numeric input fields with validation (0-255)
- **Master Control**: Global master fader with real-time scaling
- **Animation Engine**: Built-in animation patterns
  - **Sinusoid**: Smooth sine wave patterns
  - **Ramp**: Linear ramp up/down
  - **Square**: On/off square wave patterns
  - **Off**: Resets all channels to zero
- **Frequency Control**: Adjustable animation speed (0-100 Hz)
- **Quick Actions**: "All 0" and "All 255" buttons for instant testing
- **Real-time Feedback**: Visual sending indicator with LED-style blinking
- **Configurable Output**: Customizable target IP, port, net, subnet, and universe
- **Variable Send Rate**: Configurable FPS (default 44 Hz)

### 📊 Art-Net Monitor
- **Real-time Visualization**: Live grid display of incoming DMX values
- **Multi-Universe Support**: Monitor multiple universes simultaneously
- **Interactive Tooltips**: Hover over channels for detailed information
  - Current channel value
  - 10-second history graph with oscilloscope-style visualization
  - Frame count and timing data
- **Universe Tabs**: Easy switching between active universes
- **Auto-cleanup**: Automatically removes inactive universes after 10 seconds
- **Color-coded Display**: Visual intensity representation
- **Responsive Layout**: Adapts to window size with optimal channel grid

### �� Record & Playback
- **JSON Lines Format**: Industry-standard recording format
- **Frame-perfect Timing**: Preserves original timing and sequencing
- **Universe Preservation**: Maintains net/subnet/universe addressing
- **Real-time Recording**: Captures incoming Art-Net data during monitoring
- **Playback Control**: Start/stop playback with original timing
- **File Management**: Easy file selection and management

### ⚙️ Advanced Configuration
- **Persistent Settings**: All configurations saved locally
- **Network Configuration**:
  - Monitor: Bind IP and port settings
  - Sender: Target IP, port, net, subnet, universe, and frequency
- **Art-Net Compliance**: Full Art-Net 4 protocol support
- **Cross-platform**: Works on macOS, Windows, and Linux

### 🎨 User Interface
- **Modern Design**: Clean, professional interface
- **Tabbed Navigation**: Easy switching between Monitor, Sender, and Record/Play
- **Responsive Layout**: Adapts to different screen sizes
- **Keyboard Support**: Full keyboard navigation for sliders
- **Accessibility**: ARIA labels and screen reader support
- **Performance Optimized**: Smooth 60 FPS animations and updates

## Technical Specifications

- **Protocol**: Art-Net 4 (ArtDMX)
- **DMX Channels**: 512 channels per universe
- **Network**: UDP broadcast/unicast
- **Default Port**: 6454
- **Frame Rate**: Configurable (default 44 Hz)
- **Animation Rate**: 60 FPS internal
- **Recording Format**: JSON Lines (.jsonl)
- **History Buffer**: 10-second rolling buffer per channel

## Build & Run

### Prerequisites
- Rust stable
- Tauri CLI 2.x
- Node.js (for development)

### Development
```bash
# Install dependencies
pnpm install

# Start development server
cargo tauri dev
```

### Production Build
```bash
# Build for production
cargo tauri build
```

## Usage

### Monitor Tab
1. Click the gear icon to open settings
2. Configure bind IP and port (default: 0.0.0.0:6454)
3. Click "Start Monitor" to begin receiving
4. Hover over channels to see detailed tooltips with history graphs
5. Use universe tabs to switch between active universes

### Sender Tab
1. Click the gear icon to configure target settings
2. Set target IP, port, net, subnet, universe, and frequency
3. Use individual faders or numeric inputs to control channels
4. Adjust master fader for global scaling
5. Select animation mode and frequency for automated patterns
6. Click "Start Sender" to begin transmission
7. Use "All 0" / "All 255" for quick testing

### Record/Play Tab
1. **Recording**: Click "Record to..." to choose output file
2. **Playback**: Click "Open File" to select existing recording
3. **Play**: Start playback with original timing
4. **Stop**: End recording or playback as needed

## Network Configuration

- **Default Port**: 6454 (Art-Net standard)
- **Sender Default**: Broadcast to 255.255.255.255
- **Universe Addressing**: Follows Art-Net specification (SubUni = subnet << 4 | universe)
- **Firewall**: Ensure UDP port 6454 is open for your network interface

## File Structure

## Releases CI

- Tagged commits `v*` trigger a multi-OS Tauri build and create a GitHub Release with DMG (macOS), Windows, and Linux installers.
- Configure required secrets before tagging. See `docs/release-ci.md`.
