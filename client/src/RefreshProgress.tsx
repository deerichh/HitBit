import { useEffect, useRef, useState } from "react";

// Slim progress line that sits along the bottom edge INSIDE a
// Refresh button while a sheet refresh is in flight. The button
// must be `relative overflow-hidden` so the fill clips to the
// button's rounded shape. The refresh runs as a background job, so
// its exact percentage is unknowable: the line eases toward ~92%
// (fast at first, slowing as it goes) while waiting, snaps to 100%
// when the refresh lands, holds briefly, then fades out. On
// failure (active ends with `failed` set) it simply stops and
// fades away alongside the failure note. No numeric readout.
export function RefreshProgress({
  active,
  failed,
}: {
  active: boolean;
  failed: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const [opacity, setOpacity] = useState(1);
  const [snapping, setSnapping] = useState(false);
  const startRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const timersRef = useRef<number[]>([]);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if (active) {
      wasActiveRef.current = true;
      timersRef.current.forEach((t) => window.clearTimeout(t));
      timersRef.current = [];
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setVisible(true);
      setOpacity(1);
      setSnapping(false);
      setWidth(0);
      if (
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        setWidth(85);
        return;
      }
      startRef.current = performance.now();
      const tick = () => {
        const t = performance.now() - startRef.current;
        // Ease toward 92%: quick early progress that slows down
        // the longer the refresh takes.
        setWidth(92 * (1 - Math.exp(-t / 6000)));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }
    if (wasActiveRef.current) {
      wasActiveRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (failed) {
        // Timed out / failed: stop where it is and fade out with
        // the failure note.
        setOpacity(0);
        timersRef.current.push(
          window.setTimeout(() => {
            setVisible(false);
            setWidth(0);
            setOpacity(1);
          }, 350),
        );
      } else {
        // Completed: snap to full, hold a beat, fade out.
        setSnapping(true);
        setWidth(100);
        timersRef.current.push(
          window.setTimeout(() => setOpacity(0), 400),
          window.setTimeout(() => {
            setVisible(false);
            setWidth(0);
            setOpacity(1);
            setSnapping(false);
          }, 850),
        );
      }
    }
  }, [active, failed]);

  useEffect(
    () => () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  if (!visible) return null;
  return (
    <span
      role="progressbar"
      aria-label="Refresh in progress"
      className="pointer-events-none absolute right-0 bottom-0 left-0 block h-[3px] overflow-hidden"
      style={{
        backgroundColor: "var(--border)",
        opacity,
        transition: "opacity 300ms ease",
      }}
    >
      <span
        className="block h-full"
        style={{
          width: `${width}%`,
          backgroundColor: "var(--accent)",
          transition: snapping ? "width 250ms ease-out" : undefined,
        }}
      />
    </span>
  );
}
