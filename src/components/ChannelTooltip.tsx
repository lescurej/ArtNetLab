import { useEffect, useRef, memo, useMemo, useState } from "react";

interface ChannelTooltipProps {
  channel: number;
  currentValue: number;
  history:
    | {
        values: number[];
        timestamps: number[];
        writeIndex: number;
        size: number;
      }
    | undefined;
  position: { x: number; y: number };
  frameCount: number;
}

const ChannelHistoryGraph = memo(
  ({
    history,
    frameCount,
  }: {
    history:
      | {
          values: number[];
          timestamps: number[];
          writeIndex: number;
          size: number;
        }
      | undefined;
    frameCount: number;
  }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animationRef = useRef<number>(null);
    const [debouncedFrameCount, setDebouncedFrameCount] = useState(0);

    // Debounce frame updates for smoother rendering
    useEffect(() => {
      const timeout = setTimeout(() => {
        setDebouncedFrameCount(frameCount);
      }, 16); // ~60fps

      return () => clearTimeout(timeout);
    }, [frameCount]);

    // Pre-calculate values to avoid recalculation
    const { minVal, maxVal, range, data } = useMemo(() => {
      if (!history || history.size < 2) {
        return { minVal: 0, maxVal: 255, range: 255, data: [] };
      }

      // Compute the chronological start index consistently, even when buffer not full
      const bufferLen = history.values.length;
      const startIndex =
        (history.writeIndex - history.size + bufferLen) % bufferLen;

      let minVal = Infinity;
      let maxVal = -Infinity;
      const data = [] as { val: number; x: number; y: number }[];

      for (let i = 0; i < history.size; i++) {
        const index = (startIndex + i) % bufferLen;
        const val = history.values[index];
        data.push({
          val,
          x: (i / (history.size - 1)) * 180,
          y: 40 - ((val - 0) / 255) * 40, // Pre-calculate Y position
        });
        if (val > maxVal) maxVal = val;
        if (val < minVal) minVal = val;
      }

      return { minVal, maxVal, range: maxVal - minVal || 1, data };
    }, [history?.size, history?.writeIndex, frameCount]);

    useEffect(() => {
      const draw = () => {
        const canvas = canvasRef.current;
        if (!canvas || !history || history.size === 0) return;

        const ctx = canvas.getContext("2d")!;
        const width = 180;
        const height = 40;

        // High-DPI crisp rendering
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.floor(width * dpr);
        const targetH = Math.floor(height * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        // Reset and scale to CSS pixels
        // @ts-ignore older TS lib may not know setTransform signature
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Solid black background (oscilloscope style)
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, width, height);

        // Subtle grid (optional, clean oscilloscope look)
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#111";
        ctx.beginPath();
        // horizontal lines (4 divisions)
        for (let i = 1; i < 4; i++) {
          const y = (i * height) / 4;
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
        }
        // vertical lines (10 divisions)
        for (let i = 1; i < 10; i++) {
          const x = (i * width) / 10;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
        }
        ctx.stroke();

        if (data.length < 2) return;

        // Oscilloscope trace
        ctx.strokeStyle = "#0088ff"; // clean green trace
        ctx.lineWidth = 1.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();

        let firstPoint = true;
        for (const point of data) {
          const y = height - ((point.val - minVal) / range) * height;

          if (firstPoint) {
            ctx.moveTo(point.x, y);
            firstPoint = false;
          } else {
            ctx.lineTo(point.x, y);
          }
        }

        ctx.stroke();

        // No endpoint dot for clean oscilloscope look
      };

      // Use requestAnimationFrame for smooth rendering
      animationRef.current = requestAnimationFrame(draw);

      return () => {
        if (animationRef.current) {
          cancelAnimationFrame(animationRef.current);
        }
      };
    }, [history?.size, debouncedFrameCount, data, minVal, maxVal, range]);

    return (
      <div>
        <canvas
          ref={canvasRef}
          style={{
            width: "180px",
            height: "40px",
            border: "1px solid rgba(255, 255, 255, 0.2)",
            borderRadius: "4px",
          }}
        />
      </div>
    );
  }
);

const ChannelTooltip = memo(
  ({
    channel,
    currentValue,
    history,
    position,
    frameCount,
  }: ChannelTooltipProps) => {
    // Memoize expensive calculations
    const tooltipStyle = useMemo(
      () => ({
        position: "fixed" as const,
        left: position.x + 20,
        top: position.y - 50,
        background: "rgba(0, 0, 0, 0.9)",
        color: "white",
        padding: "12px",
        borderRadius: "8px",
        fontSize: "12px",
        pointerEvents: "none" as const,
        zIndex: 1000,
        minWidth: "200px",
        border: "1px solid rgba(255, 255, 255, 0.2)",
      }),
      [position.x, position.y]
    );

    return (
      <div style={tooltipStyle}>
        <div style={{ fontWeight: "bold", marginBottom: "8px" }}>
          Channel {channel}
        </div>
        <div style={{ marginBottom: "8px" }}>Current: {currentValue}</div>
        <ChannelHistoryGraph history={history} frameCount={frameCount} />
      </div>
    );
  }
);

export default ChannelTooltip;
