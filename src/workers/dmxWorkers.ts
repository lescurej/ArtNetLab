// DMX Animation Web Worker
const DMX_CHANNELS = 512;
const DMX_MAX_VALUE = 255;

type AnimationMode = "sinusoid" | "ramp" | "square" | "off";

interface AnimationMessage {
  type: "start" | "stop" | "update";
  animationMode?: AnimationMode;
  animationFreq?: number;
  masterValue?: number;
}

interface AnimationResponse {
  type: "frame";
  values: number[];
}

function generateAnimationValues(
  time: number,
  mode: string,
  freq: number
): number[] {
  const values = new Array(DMX_CHANNELS).fill(0);
  const period = 1000 / freq;
  const t = (time % period) / period;

  let value = 0;
  switch (mode) {
    case "sinusoid":
      value = (Math.sin(2 * Math.PI * t) + 1) / 2;
      break;
    case "ramp":
      value = t;
      break;
    case "square":
      value = Math.sin(2 * Math.PI * t) > 0 ? 1 : 0;
      break;
    default:
      value = 0;
  }

  const dmxValue = Math.round(value * DMX_MAX_VALUE);
  return values.fill(dmxValue);
}

function applyMasterScaling(values: number[], master: number): number[] {
  return values.map((value) => Math.round((value * master) / 255));
}

let animationMode: AnimationMode = "off";
let animationFreq = 1;
let masterValue = 255;
let isRunning = false;
let intervalId: number | null = null;

self.onmessage = (e: MessageEvent<AnimationMessage>) => {
  const {
    type,
    animationMode: mode,
    animationFreq: freq,
    masterValue: master,
  } = e.data;

  switch (type) {
    case "start":
      if (mode) animationMode = mode;
      if (freq !== undefined) animationFreq = freq;
      if (master !== undefined) masterValue = master;

      if (!isRunning) {
        isRunning = true;
        intervalId = setInterval(() => {
          if (animationMode === "off") {
            const zeroValues = new Array(DMX_CHANNELS).fill(0);
            self.postMessage({ type: "frame", values: zeroValues });
            return;
          }

          const currentTime = Date.now();
          const values = generateAnimationValues(
            currentTime,
            animationMode,
            animationFreq
          );
          const scaledValues = applyMasterScaling(values, masterValue);
          self.postMessage({ type: "frame", values: scaledValues });
        }, 16); // 60 FPS
      }
      break;

    case "stop":
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      isRunning = false;
      break;

    case "update":
      if (mode) animationMode = mode;
      if (freq !== undefined) animationFreq = freq;
      if (master !== undefined) masterValue = master;
      break;
  }
};
