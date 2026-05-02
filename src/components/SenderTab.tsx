import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
type AnimationMode = "sinusoid" | "ramp" | "square" | "chaser" | "noise" | "off";
type AnimationSelectValue = AnimationMode | "mixed";

function animationModeToCode(mode: AnimationMode): number {
  switch (mode) {
    case "sinusoid":
      return 1;
    case "ramp":
      return 2;
    case "square":
      return 3;
    case "chaser":
      return 4;
    case "noise":
      return 5;
    default:
      return 0;
  }
}

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
  selected: boolean;
  animated: boolean;
  interactionsLocked: boolean;
  onSelectChannel: (
    channel: number,
    modifiers: { additive: boolean; range: boolean }
  ) => void;
  onActivateChannel: (channel: number) => void;
  setInputRef: (channel: number, el: HTMLInputElement | null) => void;
  setCardRef: (channel: number, el: HTMLDivElement | null) => void;
  onFader: (i: number, v: number) => Promise<void>;
  onMomentaryHold: (i: number, down: boolean) => void;
  onInputChange: (i: number, value: string) => void;
}

const FaderBase = ({
  channel,
  value,
  selected,
  animated,
  interactionsLocked,
  onSelectChannel,
  onActivateChannel,
  setInputRef,
  setCardRef,
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

  const handleCardClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (
        target.closest(".fader-momentary") ||
        target.closest(".dmx-input")
      ) {
        onActivateChannel(channel);
        return;
      }
      onSelectChannel(channel, {
        additive: e.metaKey || e.ctrlKey,
        range: e.shiftKey,
      });
    },
    [channel, onActivateChannel, onSelectChannel]
  );

  return (
    <div
      className={`fader ${selected ? "selected" : ""} ${
        animated ? "animated" : ""
      }`}
      onFocusCapture={() => onActivateChannel(channel)}
      onClick={handleCardClick}
      onContextMenu={(e) => e.preventDefault()}
      ref={(el) => setCardRef(channel, el)}
    >
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
        onContextMenu={(e) => e.preventDefault()}
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
        disabled={interactionsLocked}
      />
      <input
        type="number"
        min={0}
        max={DMX_MAX_VALUE}
        value={value}
        onChange={handleInputChange}
        className="dmx-input"
        onContextMenu={(e) => e.preventDefault()}
        ref={(el) => setInputRef(channel, el)}
      />
    </div>
  );
};

const Fader = memo(FaderBase, (prev, next) => {
  return (
    prev.value === next.value &&
    prev.channel === next.channel &&
    prev.selected === next.selected &&
    prev.animated === next.animated &&
    prev.interactionsLocked === next.interactionsLocked
  );
});

// Custom hook for animation logic
const useAnimation = (
  hasAnimation: boolean,
  animationModeCodes: number[],
  animationFreq: number,
  setFaders: (faders: number[]) => void,
  masterValue: number,
  chaserFrom: number,
  chaserTo: number
) => {
  const hasAnimationRef = useRef(hasAnimation);
  const modeCodesRef = useRef(animationModeCodes);
  const fqRef = useRef(animationFreq);
  const mvRef = useRef(masterValue);
  const chaserLoRef = useRef(clampDmCh(chaserFrom));
  const chaserHiRef = useRef(clampDmCh(chaserTo));
  hasAnimationRef.current = hasAnimation;
  modeCodesRef.current = animationModeCodes;
  fqRef.current = animationFreq;
  mvRef.current = masterValue;
  chaserLoRef.current = clampDmCh(chaserFrom);
  chaserHiRef.current = clampDmCh(chaserTo);

  useEffect(() => {
    if (!hasAnimationRef.current) {
      void invoke("stop_animation");
      return;
    }

    const fq = Number.isFinite(fqRef.current) ? fqRef.current : 1;
    const mv = mvRef.current;
    const cf = chaserLoRef.current;
    const ct = chaserHiRef.current;
    const modes = modeCodesRef.current;
    void invoke("start_animation", {
      mode: "off",
      frequency: fq,
      masterValue: mv,
      chaserFrom: cf,
      chaserTo: ct,
      modes,
    }).then(() =>
      invoke("patch_animation_params", {
        frequency: fq,
        masterValue: mv,
        chaserFrom: cf,
        chaserTo: ct,
        modes,
      })
    );
  }, [hasAnimation, setFaders]);

  useEffect(() => {
    if (!hasAnimation) return;
    const fq = Number.isFinite(animationFreq) ? animationFreq : 1;
    const cf = clampDmCh(chaserFrom);
    const ct = clampDmCh(chaserTo);
    void invoke("patch_animation_params", {
      frequency: fq,
      masterValue,
      chaserFrom: cf,
      chaserTo: ct,
      modes: animationModeCodes,
    });
  }, [
    hasAnimation,
    animationModeCodes,
    animationFreq,
    masterValue,
    chaserFrom,
    chaserTo,
  ]);
  useEffect(() => {
    if (!hasAnimation) return;

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
  }, [hasAnimation, setFaders]);
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
  const [animationFreq, setAnimationFreq] = useState(1);
  const [chaserFrom, setChaserFrom] = useState(1);
  const [chaserTo, setChaserTo] = useState(512);
  const [selectedChannel, setSelectedChannel] = useState(0);
  const selectedChannelRef = useRef(0);
  const selectionAnchorRef = useRef(0);
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(
    () => new Set([0])
  );
  const selectedChannelsRef = useRef<Set<number>>(new Set([0]));
  const [channelAnimationModes, setChannelAnimationModes] = useState<
    AnimationMode[]
  >(
    () => new Array(DMX_CHANNELS).fill("off")
  );
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  useEffect(() => {
    selectedChannelRef.current = selectedChannel;
  }, [selectedChannel]);
  useEffect(() => {
    selectedChannelsRef.current = selectedChannels;
  }, [selectedChannels]);
  const setAnchor = useCallback((channel: number) => {
    selectionAnchorRef.current = channel;
  }, []);
  const hasAnimation = channelAnimationModes.some((mode) => mode !== "off");
  const animationModeCodes = useMemo(
    () => channelAnimationModes.map(animationModeToCode),
    [channelAnimationModes]
  );
  const animationSelectValue: AnimationSelectValue = (() => {
    if (selectedChannels.size === 0) return "off";
    let firstMode: AnimationMode | null = null;
    for (const ch of selectedChannels) {
      const mode = channelAnimationModes[ch] ?? "off";
      if (firstMode === null) {
        firstMode = mode;
        continue;
      }
      if (mode !== firstMode) return "mixed";
    }
    return firstMode ?? "off";
  })();

  useAnimation(
    hasAnimation,
    animationModeCodes,
    animationFreq,
    setFaders,
    masterValue,
    chaserFrom,
    chaserTo
  );

  // Memoized handlers
  const handleAnimationModeChange = useCallback(
    (mode: AnimationMode) => {
      const targets =
        selectedChannels.size > 0
          ? Array.from(selectedChannels)
          : [selectedChannel];
      setChannelAnimationModes((prev) => {
        const next = prev.slice();
        for (const ch of targets) next[ch] = mode;
        return next;
      });
    },
    [selectedChannel, selectedChannels]
  );

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
        invoke("set_channels_and_push", { values: scaledFaders }).catch(
          () => {}
        );
      }, 40);
    },
    [setMasterValue]
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
    (i: number, v: number) => {
      const selected = selectedChannelsRef.current;
      const targets =
        selected.has(i) && selected.size > 1
          ? Array.from(selected)
          : [i];
      const jobs = targets.map((ch) => onFaderRef.current(ch, v));
      return Promise.all(jobs).then(() => undefined);
    },
    []
  );
  const stableOnInput = useCallback(
    (i: number, v: string) => {
      const selected = selectedChannelsRef.current;
      const targets =
        selected.has(i) && selected.size > 1
          ? Array.from(selected)
          : [i];
      for (const ch of targets) onInputRef.current(ch, v);
    },
    []
  );
  const stableOnMomentary = useCallback(
    (i: number, down: boolean) => {
      const selected = selectedChannelsRef.current;
      const targets =
        selected.has(i) && selected.size > 1
          ? Array.from(selected)
          : [i];
      for (const ch of targets) onMomentaryRef.current(ch, down);
    },
    []
  );
  const channelInputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const faderCardsRef = useRef(new Map<number, HTMLDivElement>());
  const fadersAreaRef = useRef<HTMLDivElement | null>(null);
  const senderPaneRef = useRef<HTMLElement | null>(null);
  const rowVirtualizerRef = useRef<{
    scrollToIndex: (
      index: number,
      opts?: { align?: "auto" | "start" | "center" | "end" }
    ) => void;
  } | null>(null);
  const setChannelInputRef = useCallback(
    (channel: number, el: HTMLInputElement | null) => {
      channelInputsRef.current[channel] = el;
    },
    []
  );
  const setFaderCardRef = useCallback(
    (channel: number, el: HTMLDivElement | null) => {
      if (el) faderCardsRef.current.set(channel, el);
      else faderCardsRef.current.delete(channel);
    },
    []
  );
  const activateChannel = useCallback((channel: number) => {
    setSelectedChannel(channel);
  }, []);
  const handleChannelSelect = useCallback(
    (
      channel: number,
      modifiers: { additive: boolean; range: boolean }
    ) => {
      if (suppressClickRef.current) return;
      senderPaneRef.current?.focus();
      const currentSelected = selectedChannelsRef.current;
      const currentSelectedChannel = selectedChannelRef.current;
      const anchor =
        currentSelected.size === 1
          ? Array.from(currentSelected)[0]
          : currentSelectedChannel;
      setSelectedChannel(channel);
      setSelectedChannels((prev) => {
        if (modifiers.range) {
          const lo = Math.min(anchor, channel);
          const hi = Math.max(anchor, channel);
          const rangeSet = new Set<number>();
          for (let ch = lo; ch <= hi; ch++) rangeSet.add(ch);
          if (!modifiers.additive) {
            return rangeSet;
          }
          const allAlreadySelected = Array.from(rangeSet).every((ch) =>
            prev.has(ch)
          );
          const next = new Set(prev);
          if (allAlreadySelected) {
            for (const ch of rangeSet) next.delete(ch);
            if (next.size === 0) next.add(channel);
            return next;
          }
          for (const ch of rangeSet) next.add(ch);
          return next;
        }
        if (modifiers.additive) {
          const next = new Set(prev);
          if (next.has(channel)) {
            if (next.size > 1) next.delete(channel);
          } else {
            next.add(channel);
          }
          return next;
        }
        setAnchor(channel);
        return new Set([channel]);
      });
      if (!modifiers.range) setAnchor(channel);
    },
    [setAnchor]
  );
  const focusChannel = useCallback(
    (channel: number) => {
      const next = Math.max(0, Math.min(DMX_CHANNELS - 1, channel));
      setSelectedChannel(next);
      setSelectedChannels(new Set([next]));
      setAnchor(next);
      rowVirtualizerRef.current?.scrollToIndex(Math.floor(next / FADER_COLS), {
        align: "auto",
      });
      requestAnimationFrame(() => channelInputsRef.current[next]?.focus());
    },
    []
  );

  const handleMarqueeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (
      target.closest(".fader-momentary") ||
      target.closest(".dmx-input") ||
      target.closest(".osl-slider") ||
      target.closest(".animation-select") ||
      target.closest(".freq-input") ||
      target.closest(".btn")
    ) {
      return;
    }
    const area = fadersAreaRef.current;
    if (!area) return;
    senderPaneRef.current?.focus();
    const areaRect = area.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const additiveMarquee = e.metaKey || e.ctrlKey;
    let marqueeActive = false;
    const startThreshold = 4;

    const onMove = (ev: PointerEvent) => {
      const x = ev.clientX;
      const y = ev.clientY;
      const dx = Math.abs(x - startX);
      const dy = Math.abs(y - startY);
      if (!marqueeActive && dx < startThreshold && dy < startThreshold) {
        return;
      }
      marqueeActive = true;
      const left = Math.min(startX, x) - areaRect.left;
      const top = Math.min(startY, y) - areaRect.top;
      const width = Math.abs(x - startX);
      const height = Math.abs(y - startY);
      setMarquee({ left, top, width, height });
      const l = Math.min(startX, x);
      const r = Math.max(startX, x);
      const t = Math.min(startY, y);
      const b = Math.max(startY, y);
      const hit = new Set<number>();
      for (const [ch, el] of faderCardsRef.current.entries()) {
        const rect = el.getBoundingClientRect();
        if (
          rect.right >= l &&
          rect.left <= r &&
          rect.bottom >= t &&
          rect.top <= b
        ) {
          hit.add(ch);
        }
      }
      setSelectedChannels((prev) => {
        if (!additiveMarquee) {
          if (hit.size === 0) return new Set([selectedChannel]);
          return hit;
        }
        const next = new Set(prev);
        for (const ch of hit) next.add(ch);
        return next;
      });
      if (hit.size > 0) {
        const first = Math.min(...hit);
        setSelectedChannel(first);
        setAnchor(first);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMarquee(null);
      if (marqueeActive) {
        suppressClickRef.current = true;
        requestAnimationFrame(() => {
          suppressClickRef.current = false;
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [selectedChannel]);

  const handleSenderKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      const isDmxInput =
        target instanceof HTMLInputElement &&
        target.classList.contains("dmx-input");
      const isTextControl =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const allChannels = new Set<number>(
          Array.from({ length: DMX_CHANNELS }, (_, i) => i)
        );
        senderPaneRef.current?.focus();
        setSelectedChannels(allChannels);
        setAnchor(0);
        setSelectedChannel(0);
        return;
      }

      if (
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown" &&
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight"
      ) {
        return;
      }
      if (isTextControl && !isDmxInput) {
        return;
      }

      e.preventDefault();
      if (e.key === "ArrowLeft") {
        if (e.shiftKey) {
          const next = Math.max(0, selectedChannel - 1);
          const anchor = selectionAnchorRef.current;
          const lo = Math.min(anchor, next);
          const hi = Math.max(anchor, next);
          const range = new Set<number>();
          for (let ch = lo; ch <= hi; ch++) range.add(ch);
          setSelectedChannel(next);
          setSelectedChannels(range);
          return;
        }
        if (selectedChannels.size > 1) {
          const leftMost = Math.min(...selectedChannels);
          focusChannel(leftMost);
          return;
        }
        focusChannel(selectedChannel - 1);
        return;
      }
      if (e.key === "ArrowRight") {
        if (e.shiftKey) {
          const next = Math.min(DMX_CHANNELS - 1, selectedChannel + 1);
          const anchor = selectionAnchorRef.current;
          const lo = Math.min(anchor, next);
          const hi = Math.max(anchor, next);
          const range = new Set<number>();
          for (let ch = lo; ch <= hi; ch++) range.add(ch);
          setSelectedChannel(next);
          setSelectedChannels(range);
          return;
        }
        if (selectedChannels.size > 1) {
          const rightMost = Math.max(...selectedChannels);
          focusChannel(rightMost);
          return;
        }
        focusChannel(selectedChannel + 1);
        return;
      }

      const targets =
        selectedChannels.size > 0
          ? Array.from(selectedChannels)
          : [selectedChannel];
      const step = e.shiftKey ? 50 : 1;
      const delta = e.key === "ArrowUp" ? step : -step;
      for (const ch of targets) {
        const current = faders[ch] ?? 0;
        const next = Math.max(0, Math.min(DMX_MAX_VALUE, current + delta));
        if (next !== current) {
          void stableOnFader(ch, next);
        }
      }
    },
    [faders, focusChannel, selectedChannel, selectedChannels, stableOnFader]
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
  rowVirtualizerRef.current = rowVirtualizer;

  useLayoutEffect(() => {
    if (!isSenderViewportActive) return;
    const id = requestAnimationFrame(() => {
      rowVirtualizer.measure();
    });
    return () => cancelAnimationFrame(id);
  }, [isSenderViewportActive, rowVirtualizer]);

  return (
    <section
      ref={senderPaneRef}
      className="view active sender-pane"
      onKeyDownCapture={handleSenderKeyDown}
      tabIndex={0}
    >
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
            value={animationSelectValue}
            onChange={(e) =>
              handleAnimationModeChange(e.target.value as AnimationMode)
            }
            className="animation-select"
          >
            <option value="off">Off</option>
            {animationSelectValue === "mixed" && (
              <option value="mixed" disabled>
                Mixed
              </option>
            )}
            <option value="sinusoid">Sinusoid</option>
            <option value="ramp">Ramp</option>
            <option value="square">Square</option>
            <option value="chaser">Chaser</option>
            <option value="noise">Noise</option>
          </select>
          {animationSelectValue === "chaser" && (
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

      <div
        className="faders"
        ref={fadersAreaRef}
        onPointerDown={handleMarqueeStart}
        onContextMenu={(e) => e.preventDefault()}
      >
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
                        selected={selectedChannels.has(ch)}
                        animated={channelAnimationModes[ch] !== "off"}
                        interactionsLocked={marquee !== null}
                        onSelectChannel={handleChannelSelect}
                        onActivateChannel={activateChannel}
                        setInputRef={setChannelInputRef}
                        setCardRef={setFaderCardRef}
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
          {marquee && (
            <div
              className="fader-marquee"
              style={{
                left: marquee.left,
                top: marquee.top,
                width: marquee.width,
                height: marquee.height,
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
