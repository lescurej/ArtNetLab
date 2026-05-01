import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Slider from "./ui/Slider";

const DMX_CHANNELS = 512;
const DMX_MAX_VALUE = 255;
const FADER_COLS = 32;
const FADER_ROWS = DMX_CHANNELS / FADER_COLS;

function clampDmCh(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(512, Math.floor(n)));
}

// Types
type AnimationMode = "sinusoid" | "ramp" | "square" | "chaser" | "off";

interface SenderTabProps {
  scrollParentRef: RefObject<HTMLElement | null>;
  isSenderViewportActive: boolean;
  faders: number[];
  setFaders: (faders: number[]) => void;
  onFader: (i: number, v: number) => Promise<void>;
  onMomentaryHold: (i: number, down: boolean) => void;
  onInputChange: (i: number, value: string) => void;
  all: (v: number) => Promise<void>;
  startSender: () => Promise<void>;
  masterValue: number;
  setMasterValue: (value: number) => void;
  senderRunning: boolean;
}

// Helper function to apply master scaling
const applyMasterScaling = (values: number[], master: number): number[] => {
  return values.map((value) =>
    Math.round(Math.min(255, Math.max(0, (value * master) / 255)))
  );
};

interface FaderProps {
  channel: number;
  value: number;
  onFader: (i: number, v: number) => Promise<void>;
  onMomentaryHold: (i: number, down: boolean) => void;
  onInputChange: (i: number, value: string) => void;
}

const FaderBase = ({
  channel,
  value,
  onFader,
  onMomentaryHold,
  onInputChange,
}: FaderProps) => {
  const holdActiveRef = useRef(false);

  const handleMomentaryBegin = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      if (holdActiveRef.current) return;
      holdActiveRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      onMomentaryHold(channel, true);
    },
    [channel, onMomentaryHold]
  );

  const endMomentaryHold = useCallback(() => {
    if (!holdActiveRef.current) return;
    holdActiveRef.current = false;
    onMomentaryHold(channel, false);
  }, [channel, onMomentaryHold]);

  const handleMomentaryPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      } catch (_) {}
      endMomentaryHold();
    },
    [endMomentaryHold]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onInputChange(channel, e.currentTarget.value);
    },
    [channel, onInputChange]
  );

  const onSliderChange = useCallback(
    (v: number) => onFader(channel, v),
    [channel, onFader]
  );

  return (
    <div className="fader">
      <label>Ch {String(channel + 1).padStart(3, "0")}</label>
      <button
        type="button"
        className="fader-momentary"
        title="Hold: full brightness (master applied). Release: 0"
        aria-label={`Channel ${channel + 1} full while pressed`}
        onPointerDown={handleMomentaryBegin}
        onPointerUp={handleMomentaryPointerEnd}
        onPointerCancel={handleMomentaryPointerEnd}
        onLostPointerCapture={endMomentaryHold}
      >
        ●
      </button>
      <Slider
        value={value}
        min={0}
        max={DMX_MAX_VALUE}
        step={1}
        orientation="vertical"
        height={140}
        trackThickness={8}
        thumbSize={20}
        ariaLabel={`Channel ${channel + 1}`}
        onChange={onSliderChange}
      />
      <input
        type="number"
        min={0}
        max={DMX_MAX_VALUE}
        value={value}
        onChange={handleInputChange}
        className="dmx-input"
      />
    </div>
  );
};

const Fader = memo(FaderBase, (prev, next) => {
  return prev.value === next.value && prev.channel === next.channel;
});

// Custom hook for animation logic
const useAnimation = (
  animationMode: AnimationMode,
  animationFreq: number,
  setFaders: (faders: number[]) => void,
  masterValue: number,
  chaserFrom: number,
  chaserTo: number
) => {
  const fqRef = useRef(animationFreq);
  const mvRef = useRef(masterValue);
  const chaserLoRef = useRef(clampDmCh(chaserFrom));
  const chaserHiRef = useRef(clampDmCh(chaserTo));
  fqRef.current = animationFreq;
  mvRef.current = masterValue;
  chaserLoRef.current = clampDmCh(chaserFrom);
  chaserHiRef.current = clampDmCh(chaserTo);

  useEffect(() => {
    if (animationMode === "off") {
      void invoke("stop_animation");
      const zeroValues = new Array(DMX_CHANNELS).fill(0);
      setFaders(zeroValues);
      void invoke("set_channels", { values: zeroValues });
      return;
    }

    const fq = Number.isFinite(fqRef.current) ? fqRef.current : 1;
    const mv = mvRef.current;
    const cf = chaserLoRef.current;
    const ct = chaserHiRef.current;
    void invoke("start_animation", {
      mode: animationMode,
      frequency: fq,
      masterValue: mv,
      chaserFrom: cf,
      chaserTo: ct,
    }).then(() =>
      invoke(
        "patch_animation_params",
        animationMode === "chaser"
          ? { frequency: fq, masterValue: mv, chaserFrom: cf, chaserTo: ct }
          : { frequency: fq, masterValue: mv }
      )
    );
  }, [animationMode, setFaders]);

  useEffect(() => {
    if (animationMode === "off") return;
    const fq = Number.isFinite(animationFreq) ? animationFreq : 1;
    const cf = clampDmCh(chaserFrom);
    const ct = clampDmCh(chaserTo);
    void invoke(
      "patch_animation_params",
      animationMode === "chaser"
        ? { frequency: fq, masterValue, chaserFrom: cf, chaserTo: ct }
        : { frequency: fq, masterValue }
    );
  }, [
    animationMode,
    animationFreq,
    masterValue,
    chaserFrom,
    chaserTo,
  ]);
  useEffect(() => {
    if (animationMode === "off") return;

    const slot: { values: number[] | null } = { values: null };
    let raf = 0;
    let scheduled = false;
    const lastBuf = new Uint8Array(DMX_CHANNELS);

    const flush = () => {
      scheduled = false;
      const incoming = slot.values;
      slot.values = null;
      if (!incoming) return;
      const values = incoming;
      const len = Math.min(DMX_CHANNELS, values.length);
      let changed = false;
      for (let i = 0; i < len; i++) {
        const v = values[i] | 0;
        if (lastBuf[i] !== v) changed = true;
        lastBuf[i] = v;
      }
      for (let i = len; i < DMX_CHANNELS; i++) {
        if (lastBuf[i] !== 0) changed = true;
        lastBuf[i] = 0;
      }
      if (!changed) return;
      setFaders(Array.from(lastBuf));
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      raf = requestAnimationFrame(flush);
    };

    const unlisten = listen<number[]>("sender:preview", (e) => {
      if (!e.payload) return;
      slot.values = e.payload;
      schedule();
    });

    return () => {
      cancelAnimationFrame(raf);
      unlisten.then((fn) => fn());
    };
  }, [animationMode, setFaders]);
};

export default function SenderTab({
  scrollParentRef,
  isSenderViewportActive,
  faders,
  setFaders,
  onFader,
  onMomentaryHold,
  onInputChange,
  all,
  startSender,
  masterValue,
  setMasterValue,
  senderRunning,
}: SenderTabProps) {
  // Animation state
  const [animationMode, setAnimationMode] = useState<AnimationMode>("off");
  const [animationFreq, setAnimationFreq] = useState(1);
  const [chaserFrom, setChaserFrom] = useState(1);
  const [chaserTo, setChaserTo] = useState(512);

  useAnimation(
    animationMode,
    animationFreq,
    setFaders,
    masterValue,
    chaserFrom,
    chaserTo
  );

  // Memoized handlers
  const handleAnimationModeChange = useCallback((mode: AnimationMode) => {
    setAnimationMode(mode);
  }, []);

  const handleFreqChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setAnimationFreq(Number(e.target.value));
    },
    []
  );

  const fadersForMasterRef = useRef(faders);
  const masterDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    fadersForMasterRef.current = faders;
  }, [faders]);

  const handleMasterChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      setMasterValue(value);
      if (masterDebounceRef.current != null) {
        window.clearTimeout(masterDebounceRef.current);
      }
      masterDebounceRef.current = window.setTimeout(() => {
        masterDebounceRef.current = null;
        const scaledFaders = applyMasterScaling(
          fadersForMasterRef.current,
          value
        );
        invoke("set_channels", { values: scaledFaders });
        if (senderRunning) invoke("push_frame").catch(() => {});
      }, 40);
    },
    [setMasterValue, senderRunning]
  );

  // Memoized faders array
  // Stable function refs so child memoized Faders don't re-render due to fn identity
  const onFaderRef = useRef(onFader);
  const onMomentaryRef = useRef(onMomentaryHold);
  const onInputRef = useRef(onInputChange);
  useEffect(() => {
    onFaderRef.current = onFader;
    onMomentaryRef.current = onMomentaryHold;
    onInputRef.current = onInputChange;
  }, [onFader, onMomentaryHold, onInputChange]);
  const stableOnFader = useCallback(
    (i: number, v: number) => onFaderRef.current(i, v),
    []
  );
  const stableOnInput = useCallback(
    (i: number, v: string) => onInputRef.current(i, v),
    []
  );
  const stableOnMomentary = useCallback(
    (i: number, down: boolean) => onMomentaryRef.current(i, down),
    []
  );

  const rowVirtualizer = useVirtualizer({
    enabled: isSenderViewportActive && FADER_ROWS > 0,
    count: FADER_ROWS,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 328,
    overscan: FADER_ROWS,
    gap: 8,
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: true,
    rangeExtractor:
      FADER_ROWS <= 24
        ? () =>
            Array.from({ length: FADER_ROWS }, (_, i) => i)
        : (range: Parameters<typeof defaultRangeExtractor>[0]) =>
            defaultRangeExtractor(range),
  });

  useLayoutEffect(() => {
    if (!isSenderViewportActive) return;
    const id = requestAnimationFrame(() => {
      rowVirtualizer.measure();
    });
    return () => cancelAnimationFrame(id);
  }, [isSenderViewportActive, rowVirtualizer]);

  return (
    <section className="view active sender-pane">
      <div className="controls">
        <div className="controls-left">
          <button
            className={`btn ${
              senderRunning ? "sender-stop pulse-send" : "sender-start"
            }`}
            onClick={startSender}
          >
            {senderRunning ? "Stop Sender" : "Start Sender"}
          </button>
          <button className="btn" onClick={() => all(0)}>
            All 0
          </button>
          <button className="btn" onClick={() => all(255)}>
            All 255
          </button>
          <label className="animation-label">Animation:</label>
          <select
            value={animationMode}
            onChange={(e) =>
              handleAnimationModeChange(e.target.value as AnimationMode)
            }
            className="animation-select"
          >
            <option value="off">Off</option>
            <option value="sinusoid">Sinusoid</option>
            <option value="ramp">Ramp</option>
            <option value="square">Square</option>
            <option value="chaser">Chaser</option>
          </select>
          {animationMode === "chaser" && (
            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <label className="chaser-range-label">Ch</label>
              <input
                type="number"
                min={1}
                max={512}
                step={1}
                value={chaserFrom}
                onChange={(e) =>
                  setChaserFrom(clampDmCh(Number(e.target.value)))
                }
                className="freq-input chaser-channel-input"
                aria-label="Chaser start channel"
              />
              <span style={{ opacity: 0.7 }}>→</span>
              <input
                type="number"
                min={1}
                max={512}
                step={1}
                value={chaserTo}
                onChange={(e) => setChaserTo(clampDmCh(Number(e.target.value)))}
                className="freq-input chaser-channel-input"
                aria-label="Chaser end channel"
              />
            </span>
          )}
          <label className="freq-label">Freq:</label>
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={animationFreq}
            onChange={handleFreqChange}
            className="freq-input"
            placeholder="Hz"
          />
        </div>
        <div
          className="controls-right"
          style={{ display: "flex", gap: 8, alignItems: "center" }}
        >
          <label className="master-label">Master:</label>
          <Slider
            value={masterValue}
            min={0}
            max={255}
            step={1}
            orientation="horizontal"
            height={140} /* used as width for horizontal in Slider */
            trackThickness={6}
            thumbSize={16}
            ariaLabel="Master"
            onChange={(v) =>
              handleMasterChange({ target: { value: String(v) } } as any)
            }
          />
          <span className="master-value">{masterValue}</span>
        </div>
      </div>

      <div className="faders">
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const base = vi.index * FADER_COLS;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <div className="faders-row">
                  {Array.from({ length: FADER_COLS }, (_, c) => {
                    const ch = base + c;
                    return (
                      <Fader
                        key={ch}
                        channel={ch}
                        value={faders[ch] ?? 0}
                        onFader={stableOnFader}
                        onMomentaryHold={stableOnMomentary}
                        onInputChange={stableOnInput}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
