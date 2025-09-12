import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Slider from "./ui/Slider";

// Constants
const DMX_CHANNELS = 512;
const DMX_MAX_VALUE = 255;

// Types
type AnimationMode = "sinusoid" | "ramp" | "square" | "off";

type Frame = {
  values: number[];
  net: number;
  subnet: number;
  universe: number;
};

interface SenderTabProps {
  faders: number[];
  setFaders: (faders: number[]) => void;
  onFader: (i: number, v: number) => Promise<void>;
  onInputChange: (i: number, value: string) => void;
  all: (v: number) => Promise<void>;
  startSender: () => Promise<void>;
  masterValue: number;
  setMasterValue: (value: number) => void;
  senderRunning: boolean;
}

// Helper function to apply master scaling
const applyMasterScaling = (values: number[], master: number): number[] => {
  return values.map((value) => Math.round((value * master) / 255));
};

interface FaderProps {
  channel: number;
  value: number;
  onFader: (i: number, v: number) => Promise<void>;
  onInputChange: (i: number, value: string) => void;
}

// Individual Fader Component
const FaderBase = ({ channel, value, onFader, onInputChange }: FaderProps) => {
  // Range change handler replaced by custom Slider component

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
  masterValue: number
) => {
  useEffect(() => {
    if (animationMode === "off") {
      invoke("stop_animation");
      const zeroValues = new Array(DMX_CHANNELS).fill(0);
      setFaders(zeroValues);
      invoke("set_channels", { values: zeroValues });
      return;
    }

    // Start backend animation
    invoke("start_animation", {
      mode: animationMode,
      frequency: animationFreq,
      masterValue: masterValue,
    });

    return () => {
      invoke("stop_animation");
    };
  }, [animationMode, animationFreq, masterValue]);

  // Listen for DMX frames to update faders during animation
  useEffect(() => {
    if (animationMode === "off") return;

    const unlisten = listen<Frame>("artnet:dmx", (e) => {
      const frame = e.payload;
      if (!frame) return;

      // Update faders with the received DMX values
      const values = frame.values || [];
      const faderValues = new Array(DMX_CHANNELS).fill(0);
      for (let i = 0; i < Math.min(DMX_CHANNELS, values.length); i++) {
        faderValues[i] = values[i];
      }
      setFaders(faderValues);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [animationMode, setFaders]);
};

export default function SenderTab({
  faders,
  setFaders,
  onFader,
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
  const [isSending, setIsSending] = useState(false);

  // Use custom animation hook
  useAnimation(animationMode, animationFreq, setFaders, masterValue);

  // Simulate sending activity when sender is running
  useEffect(() => {
    if (!senderRunning) {
      setIsSending(false);
      return;
    }

    // Set sending to true immediately when sender starts
    setIsSending(true);

    // Simulate periodic sending activity
    const interval = setInterval(() => {
      setIsSending(true);
      // Reset after a brief moment to create the blinking effect
      setTimeout(() => setIsSending(false), 150);
    }, 300); // Blink every 300ms like a fast LED

    return () => {
      clearInterval(interval);
      setIsSending(false);
    };
  }, [senderRunning]);

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

  const handleMasterChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      setMasterValue(value);

      // Apply master scaling to current fader values and send
      const scaledFaders = applyMasterScaling(faders, value);
      invoke("set_channels", { values: scaledFaders });
      invoke("push_frame");
    },
    [faders, setMasterValue]
  );

  // Memoized faders array
  // Stable function refs so child memoized Faders don't re-render due to fn identity
  const onFaderRef = useRef(onFader);
  const onInputRef = useRef(onInputChange);
  useEffect(() => {
    onFaderRef.current = onFader;
    onInputRef.current = onInputChange;
  }, [onFader, onInputChange]);
  const stableOnFader = useCallback(
    (i: number, v: number) => onFaderRef.current(i, v),
    []
  );
  const stableOnInput = useCallback(
    (i: number, v: string) => onInputRef.current(i, v),
    []
  );

  const fadersArray = useMemo(() => {
    return Array.from({ length: DMX_CHANNELS }, (_, i) => (
      <Fader
        key={i}
        channel={i}
        value={faders[i] ?? 0}
        onFader={stableOnFader}
        onInputChange={stableOnInput}
      />
    ));
  }, [faders, stableOnFader, stableOnInput]);

  return (
    <section className="view active">
      <div className="controls">
        <div className="controls-left">
          <button
            className={`btn ${senderRunning ? "sender-stop" : "sender-start"}${
              isSending ? " sending" : ""
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
          </select>
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

      <div className="faders">{fadersArray}</div>
    </section>
  );
}
