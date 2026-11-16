import {
useCallback,
useEffect,
useRef,
useState,
type CSSProperties,
type MouseEvent as ReactMouseEvent,
type PointerEvent as ReactPointerEvent,
type RefObject,
} from "react";

/**
 * Shared popup behaviour (Beta 0.04, audit #6) — one spec for the
 * whole app:
 *
 * - The ⓘ info popups are HOLD-TO-SHOW: the popup appears the
 *   moment its button is pressed, stays up while the button is
 *   held, and once the button is released it fades away, gone
 *   within 2 seconds of the release. The buttons are real <button>
 *   elements with text selection and the OS touch callout disabled
 *   (see INFO_BUTTON_STYLE), so holding one can never summon the
 *   phone's copy/paste menu — that failure belonged to holding
 *   selectable TEXT, not a button.
 * - Dropdown menus (Source, Savings) dismiss on an outside tap,
 *   on scroll, or on Escape — the same dismissal the ⓘ popups
 *   have always had.
 */

/** Style every ⓘ info button carries: no text selection and no
    OS touch callout while held, so a hold stays a hold. */
export const INFO_BUTTON_STYLE: CSSProperties = {
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
  touchAction: "manipulation",
};

/**
 * Hold-to-show state for one ⓘ info popup.
 *
 * `visible` renders the popup; `fading` drives its opacity
 * transition (the popup element sets `opacity: fading ? 0 : 1`
 * with a 0.7s transition). On release the popup holds fully
 * visible for 1.2s, then fades over 0.7s — fully gone 1.9s after
 * the release, inside the 2-second spec.
 *
 * A keyboard click (a click with no pointer behind it) toggles
 * the popup instead, so it stays reachable without a pointer;
 * while shown that way it dismisses on an outside press, on
 * scroll, or on Escape, like the menus.
 */
export function useHoldInfo() {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const heldRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  }, []);

  const hideNow = useCallback(() => {
    clearTimers();
    heldRef.current = false;
    setFading(false);
    setVisible(false);
  }, [clearTimers]);

  const show = useCallback(() => {
    clearTimers();
    heldRef.current = true;
    setFading(false);
    setVisible(true);
  }, [clearTimers]);

  const release = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    clearTimers();
    timersRef.current.push(
      window.setTimeout(() => setFading(true), 1200),
      window.setTimeout(() => {
        setFading(false);
        setVisible(false);
      }, 1900),
    );
  }, [clearTimers]);

  // Unmount: no timer may fire into a gone component.
  useEffect(() => clearTimers, [clearTimers]);

  // While the popup is shown WITHOUT a hold (keyboard toggle),
  // an outside press, a scroll, or Escape dismisses it — the
  // same dismissal the dropdown menus use.
  useEffect(() => {
    if (!visible || heldRef.current) return;
    const onPress = (e: PointerEvent) => {
      const t = e.target;
      if (
        t instanceof Element &&
        t.closest("[data-hold-info-root]")
      )
        return;
      hideNow();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideNow();
    };
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("scroll", hideNow, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("scroll", hideNow, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [visible, hideNow]);

  /** Spread onto the ⓘ <button>. */
  const buttonProps = {
    "aria-expanded": visible,
    onPointerDown: (e: ReactPointerEvent) => {
      // Holding must never start a text selection or a scroll.
      e.preventDefault();
      show();
    },
    onPointerUp: release,
    onPointerLeave: release,
    onPointerCancel: release,
    onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
    onClick: (e: ReactMouseEvent) => {
      // Pointer clicks already ran the hold cycle above; only a
      // keyboard-generated click (detail 0) toggles.
      if (e.detail !== 0) return;
      if (visible) hideNow();
      else {
        clearTimers();
        heldRef.current = false;
        setFading(false);
        setVisible(true);
      }
    },
  };

  return { visible, fading, buttonProps };
}

/**
 * The one dismissal spec for dropdown menus: while `open`, a
 * press outside `ref`'s element, a scroll anywhere, or Escape
 * closes the menu. (Capture-phase, matching the ⓘ popups'
 * long-standing dismissal.)
 */
export function useMenuDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const dismiss = () => closeRef.current();
    const onPress = (e: PointerEvent) => {
      if (
        ref.current &&
        e.target instanceof Node &&
        ref.current.contains(e.target)
      )
        return;
      dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, ref]);
}
