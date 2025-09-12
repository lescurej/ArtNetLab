import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { Stage, Layer, Rect, Text, Group } from "react-konva";
import ChannelTooltip from "./ChannelTooltip";

type Frame = {
  values: number[];
  net: number;
  subnet: number;
  universe: number;
};

interface ChannelData {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  channel: number;
}

// Create a memoized channel component with better optimization
const ChannelComponent = ({
  channel,
  value,
  onMouseEnter,
  onMouseLeave,
}: {
  channel: ChannelData;
  value: number;
  onMouseEnter: (channel: number) => void;
  onMouseLeave: () => void;
}) => {
  // Memoize the value bar height calculation
  const valueBarHeight = useMemo(() => {
    return (value / 255) * channel.height;
  }, [value, channel.height]);

  // Memoize the value bar Y position
  const valueBarY = useMemo(() => {
    return channel.height - valueBarHeight;
  }, [channel.height, valueBarHeight]);

  // Memoize font sizes - optimized for smaller cells
  const valueFontSize = useMemo(() => {
    return Math.min(10, Math.max(6, channel.height * 0.6));
  }, [channel.height]);

  const channelFontSize = useMemo(() => {
    return Math.min(8, Math.max(4, channel.height * 0.4));
  }, [channel.height]);

  return (
    <Group
      key={channel.channel}
      x={channel.x}
      y={channel.y}
      onMouseEnter={() => onMouseEnter(channel.channel)}
      onMouseLeave={onMouseLeave}
    >
      {/* Background */}
      <Rect
        width={channel.width}
        height={channel.height}
        fill="#0f1622"
        stroke="#243146"
        strokeWidth={0.5}
        cache={{ pixelRatio: 1, hitGraphEnabled: true }}
      />

      {/* Value bar */}
      {value > 0 && (
        <Rect
          x={0}
          y={valueBarY}
          width={channel.width}
          height={valueBarHeight}
          fill="rgba(90,176,255,0.6)"
        />
      )}

      {/* Value text (centered horizontally) */}
      <Text
        x={0}
        y={channel.height * 0.05}
        width={channel.width}
        text={String(value)}
        fontSize={valueFontSize}
        fontFamily="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial"
        fontStyle="bold"
        fill="#e6f0ff"
        align="center"
      />

      {/* Channel number (centered horizontally) */}
      <Text
        x={0}
        y={channel.height * 0.6}
        width={channel.width}
        text={String(channel.channel)}
        fontSize={channelFontSize}
        fontFamily="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial"
        fontStyle="300"
        fill="#9fb3c8"
        align="center"
      />
    </Group>
  );
};

// Memoize the default channels calculation
const defaultChannels = (stageWidth: number, stageHeight: number) => {
  const cols = 32;
  const rows = 16;
  const padding = 10;
  const gap = 5;

  const cellW = (stageWidth - padding * 2 - gap * (cols - 1)) / cols;
  const cellH = (stageHeight - padding * 2 - gap * (rows - 1)) / rows;

  const newChannels: ChannelData[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const channel = r * cols + c + 1;
      newChannels.push({
        x: padding + c * (cellW + gap),
        y: padding + r * (cellH + gap),
        width: cellW,
        height: cellH,
        value: 0,
        channel,
      });
    }
  }
  return newChannels;
};

export default function MonitorCanvas() {
  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isUpdatingSizeRef = useRef(false);
  const [universes, setUniverses] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const universeLastSeenRef = useRef<Map<string, number>>(new Map());
  const universeSeenCountRef = useRef<Map<string, number>>(new Map());
  const [hoveredChannel, setHoveredChannel] = useState<number | null>(null);
  const currentBufRef = useRef<Uint8Array>(new Uint8Array(512));
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const channelHistoryRef = useRef<
    Map<
      number,
      {
        values: number[];
        timestamps: number[];
        writeIndex: number;
        size: number;
      }
    >
  >(new Map());
  const HISTORY_DURATION_MS = 10000;
  const UNIVERSE_TTL_MS = 10000; // remove universes not seen in 10s
  const BUFFER_SIZE = 440;
  const [frameCount, setFrameCount] = useState(0);
  const [stageSize, setStageSize] = useState({ width: 800, height: 400 });
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [channelValues, setChannelValues] = useState<Uint8Array>(
    new Uint8Array(512)
  );

  // Memoize the mouse position update to prevent unnecessary re-renders
  const handleMouseMove = useCallback(
    (e: any) => {
      const stage = e.target.getStage();
      const pos = stage.getPointerPosition();

      // Only update if position actually changed
      if (mousePos.x !== pos.x || mousePos.y !== pos.y) {
        setMousePos({ x: pos.x, y: pos.y });
      }
    },
    [mousePos.x, mousePos.y]
  );

  // Memoize mouse event handlers
  const handleMouseEnter = useCallback((channel: number) => {
    setHoveredChannel(channel);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredChannel(null);
  }, []);

  // Memoize the channel values update
  const updateChannels = useCallback((newValues: Uint8Array) => {
    setChannelValues(newValues);
  }, []);

  // Memoize the history update function
  const updateHistory = useCallback(
    (vals: number[], now: number) => {
      const len = Math.min(512, vals.length);

      for (let i = 0; i < len; i++) {
        let history = channelHistoryRef.current.get(i);
        if (!history) {
          history = {
            values: new Array(BUFFER_SIZE).fill(0),
            timestamps: new Array(BUFFER_SIZE).fill(0),
            writeIndex: 0,
            size: 0,
          };
          channelHistoryRef.current.set(i, history);
        }

        history.values[history.writeIndex] = vals[i] | 0;
        history.timestamps[history.writeIndex] = now;
        history.writeIndex = (history.writeIndex + 1) % BUFFER_SIZE;
        history.size = Math.min(history.size + 1, BUFFER_SIZE);

        // Clean old data
        const cutoff = now - HISTORY_DURATION_MS;
        while (
          history.size > 0 &&
          history.timestamps[
            (history.writeIndex - history.size + BUFFER_SIZE) % BUFFER_SIZE
          ] < cutoff
        ) {
          history.size--;
        }
      }
    },
    [BUFFER_SIZE, HISTORY_DURATION_MS]
  );

  // Handle window resize and initial sizing
  useEffect(() => {
    let timeoutId: number;

    const updateSize = () => {
      if (containerRef.current && !isUpdatingSizeRef.current) {
        isUpdatingSizeRef.current = true;
        const rect = containerRef.current.getBoundingClientRect();
        const newSize = { width: rect.width, height: rect.height };

        // Only update if size actually changed to prevent infinite loops
        setStageSize((prevSize) => {
          if (
            Math.abs(prevSize.width - newSize.width) > 5 ||
            Math.abs(prevSize.height - newSize.height) > 5
          ) {
            return newSize;
          }
          return prevSize;
        });

        // Reset the flag after a short delay
        setTimeout(() => {
          isUpdatingSizeRef.current = false;
        }, 50);
      }
    };

    // Debounced resize handler
    const debouncedUpdateSize = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(updateSize, 100);
    };

    // Initial size calculation
    updateSize();

    // Listen for resize events with debouncing
    window.addEventListener("resize", debouncedUpdateSize);

    // Use ResizeObserver with debouncing
    const resizeObserver = new ResizeObserver(debouncedUpdateSize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("resize", debouncedUpdateSize);
      resizeObserver.disconnect();
    };
  }, []);

  // Memoize channels calculation to prevent unnecessary recalculations
  const memoizedChannels = useMemo(() => {
    if (stageSize.width > 0 && stageSize.height > 0) {
      return defaultChannels(stageSize.width, stageSize.height);
    }
    return [];
  }, [stageSize.width, stageSize.height]);

  // Update channels when memoized channels change
  useEffect(() => {
    setChannels(memoizedChannels);
  }, [memoizedChannels]);

  // Reset buffers and history when selected universe changes
  useEffect(() => {
    // Clear current displayed values until next frame of selected arrives
    setChannelValues(new Uint8Array(512));
    currentBufRef.current = new Uint8Array(512);
    channelHistoryRef.current = new Map();
  }, [selected]);

  // Subscribe to Art-Net frames
  useEffect(() => {
    const un = listen<Frame>("artnet:dmx", (e) => {
      const p = e.payload;
      if (!p) return;
      const key = `${p.net}/${p.subnet}/${p.universe}`;
      let buf = currentBufRef.current;
      if (!buf) {
        buf = new Uint8Array(512);
        currentBufRef.current = buf;
      }

      // Mark last-seen for this universe and ensure it's listed
      const now = Date.now();
      universeLastSeenRef.current.set(key, now);
      // require at least 2 frames before listing to avoid transient ghosts
      const cnt = (universeSeenCountRef.current.get(key) || 0) + 1;
      universeSeenCountRef.current.set(key, cnt);
      if (cnt >= 2) {
        setUniverses((u) => (u.includes(key) ? u : [...u, key]));
        if (!selected) setSelected(key);
      }

      // Only update display for the selected universe
      const target = !selected || key === selected;
      if (!target) {
        return;
      }
      const vals = p.values || [];
      const len = Math.min(512, vals.length);

      // Only update if values actually changed
      let hasChanges = false;
      for (let i = 0; i < len; i++) {
        const newVal = vals[i] | 0;
        if (buf[i] !== newVal) {
          buf[i] = newVal;
          hasChanges = true;
        }
      }

      if (hasChanges) {
        updateChannels(new Uint8Array(buf));
      }

      // Update history for all channels
      updateHistory(vals, now);

      setFrameCount((prev) => prev + 1);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [selected, updateChannels, updateHistory]);

  // Periodically prune universes not seen within TTL
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setUniverses((prev) => {
        const keep = prev.filter((k) => {
          const last = universeLastSeenRef.current.get(k) || 0;
          return now - last <= UNIVERSE_TTL_MS;
        });
        if (keep.length !== prev.length) {
          // Cleanup lastSeen entries
          for (const k of prev) {
            if (!keep.includes(k)) universeLastSeenRef.current.delete(k);
            if (!keep.includes(k)) universeSeenCountRef.current.delete(k);
          }
          // Fix selection if removed
          if (selected && !keep.includes(selected)) {
            setSelected(keep[0] || "");
          }
        }
        return keep;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [selected]);

  // Memoize the stage props to prevent unnecessary re-renders
  const stageProps = useMemo(
    () => ({
      width: stageSize.width,
      height: stageSize.height,
      onMouseMove: handleMouseMove,
      style: { border: "1px solid rgb(42, 82, 119)", borderRadius: 8 },
      listening: true,
      hitGraphEnabled: true,
      perfectDrawEnabled: false,
      imageSmoothingEnabled: true,
    }),
    [handleMouseMove, stageSize.width, stageSize.height]
  );

  // Memoize the layer props
  const layerProps = useMemo(
    () => ({
      listening: true,
      hitGraphEnabled: true,
      perfectDrawEnabled: false,
    }),
    []
  );

  return (
    <div style={{ width: "100%" }}>
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", minHeight: "400px" }}
      >
        {universes.length > 0 ? (
          <Stage ref={stageRef} {...stageProps}>
            <Layer {...layerProps}>
              {channels.map((channel) => (
                <ChannelComponent
                  key={channel.channel}
                  channel={channel}
                  value={channelValues[channel.channel - 1] || 0}
                  onMouseEnter={handleMouseEnter}
                  onMouseLeave={handleMouseLeave}
                />
              ))}
            </Layer>
          </Stage>
        ) : null}
      </div>

      {/* Universe tabs (outside measured container to avoid feedback sizing) */}
      <div className="universe-tabs" style={{ marginTop: "10px" }}>
        {universes.length === 0 && (
          <span className="utab empty">No universes yet</span>
        )}
        {universes.map((key) => {
          const [n, s, u] = key.split("/");
          const active = key === selected;
          return (
            <button
              key={key}
              className={`utab ${active ? "active" : ""}`}
              onClick={() => setSelected(key)}
              title={`Net ${n} / Subnet ${s} / Universe ${u}`}
            >
              {n}/{s}/{u}
            </button>
          );
        })}
      </div>

      {hoveredChannel && (
        <ChannelTooltip
          channel={hoveredChannel}
          currentValue={currentBufRef.current[hoveredChannel - 1] || 0}
          history={channelHistoryRef.current.get(hoveredChannel - 1)}
          position={mousePos}
          frameCount={frameCount}
        />
      )}
    </div>
  );
}
