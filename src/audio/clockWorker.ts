// A bare interval that keeps ticking when the tab is in the background.
//
// Browsers throttle window.setInterval to about once a second in hidden tabs,
// which would starve the lookahead scheduler and drop audio. Worker timers
// aren't throttled the same way, so the clock lives here.

interface ClockMessage {
  type: "start" | "stop";
  interval?: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ClockMessage>) => void) | null;
  postMessage: (message: unknown) => void;
};

let timer: ReturnType<typeof setInterval> | null = null;

scope.onmessage = (event) => {
  const { type, interval } = event.data;

  if (type === "start") {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => scope.postMessage("tick"), Math.max(5, interval ?? 25));
    return;
  }

  if (type === "stop" && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
};
