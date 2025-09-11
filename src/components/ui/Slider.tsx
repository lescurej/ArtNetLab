import React, { useCallback, useMemo, useRef } from "react";

export type SliderOrientation = "vertical" | "horizontal";

interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  orientation?: SliderOrientation;
  height?: number; // for vertical (px)
  trackThickness?: number; // px
  thumbSize?: number; // px
  className?: string;
  ariaLabel?: string;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function roundToStep(n: number, step: number, min: number) {
  const k = Math.round((n - min) / step);
  return min + k * step;
}

export default function Slider({
  value,
  onChange,
  min = 0,
  max = 255,
  step = 1,
  orientation = "vertical",
  height = 140,
  trackThickness = 8,
  thumbSize = 20,
  className = "",
  ariaLabel,
}: SliderProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  const ratio = useMemo(() => {
    const r = (value - min) / (max - min || 1);
    return clamp(r, 0, 1);
  }, [value, min, max]);

  const coordsFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = rootRef.current;
      if (!el) return ratio;
      const rect = el.getBoundingClientRect();
      if (orientation === "vertical") {
        const usable = height - thumbSize;
        const yFromTop = clientY - rect.top - thumbSize / 2;
        const clamped = clamp(yFromTop, 0, usable);
        const r = 1 - clamped / usable;
        return clamp(r, 0, 1);
      } else {
        const usable = rect.width - thumbSize;
        const xFromLeft = clientX - rect.left - thumbSize / 2;
        const clamped = clamp(xFromLeft, 0, usable);
        const r = clamped / usable;
        return clamp(r, 0, 1);
      }
    },
    [ratio, orientation, height, thumbSize]
  );

  const commitRatio = useCallback(
    (r: number) => {
      const v = min + r * (max - min);
      const snapped = roundToStep(v, step, min);
      onChange(clamp(Math.round(snapped), min, max));
    },
    [min, max, step, onChange]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const r = coordsFromPointer(e.clientX, e.clientY);
      commitRatio(r);
    },
    [coordsFromPointer, commitRatio]
  );

  // Throttle move handling to animation frames for smoother updates
  const rafRef = useRef<number | null>(null);
  const lastXY = useRef<{ x: number; y: number } | null>(null);
  const pump = useCallback(() => {
    rafRef.current = null;
    if (!lastXY.current) return;
    const { x, y } = lastXY.current;
    const r = coordsFromPointer(x, y);
    commitRatio(r);
  }, [coordsFromPointer, commitRatio]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons === 0) return; // only when dragging
      lastXY.current = { x: e.clientX, y: e.clientY };
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(pump);
      }
    },
    [pump]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      let delta = 0;
      switch (e.key) {
        case "ArrowUp":
        case "ArrowRight":
          delta = step;
          break;
        case "ArrowDown":
        case "ArrowLeft":
          delta = -step;
          break;
        case "PageUp":
          delta = step * 10;
          break;
        case "PageDown":
          delta = -step * 10;
          break;
        case "Home":
          onChange(min);
          e.preventDefault();
          return;
        case "End":
          onChange(max);
          e.preventDefault();
          return;
        default:
          return;
      }
      e.preventDefault();
      onChange(clamp(roundToStep(value + delta, step, min), min, max));
    },
    [value, step, min, max, onChange]
  );

  // Layout variables for CSS
  const styleVars: React.CSSProperties = {
    // @ts-ignore custom props used in CSS
    "--osl-width":
      orientation === "vertical"
        ? `${Math.max(thumbSize + 4, 24)}px`
        : `${height}px`,
    // @ts-ignore
    "--osl-height":
      orientation === "vertical"
        ? `${height}px`
        : `${Math.max(thumbSize + 4, 24)}px`,
    // @ts-ignore
    "--osl-track": `${trackThickness}px`,
    // @ts-ignore
    "--osl-thumb": `${thumbSize}px`,
  } as React.CSSProperties;

  const thumbPosStyle: React.CSSProperties =
    orientation === "vertical"
      ? { top: `${(height - thumbSize) * (1 - ratio)}px` }
      : {
          left: `${
            ((rootRef.current?.clientWidth || 0) - thumbSize) * ratio
          }px`,
        };

  return (
    <div
      ref={rootRef}
      className={`osl-slider ${orientation} ${className || ""}`}
      style={styleVars}
      role="slider"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
    >
      <div className="osl-track" />
      <div className="osl-thumb" style={thumbPosStyle} />
    </div>
  );
}
