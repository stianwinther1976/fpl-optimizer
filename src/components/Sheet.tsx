"use client";

// Shared bottom-sheet dialog: Escape to close, body scroll lock, focus
// management, safe-area padding and a consistent max height. Used by all
// modals so behavior stays uniform.

import { useEffect, useRef } from "react";

export default function Sheet({
  onClose,
  labelledBy,
  children,
  maxWidth = "max-w-lg",
}: {
  onClose: () => void;
  labelledBy?: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  /*
   * `onClose` in a ref, because the history effect below must run EXACTLY ONCE
   * per sheet. A parent that re-renders hands down a new closure, and an effect
   * keyed on it would push a second entry every time — so the reader's back
   * gesture would close nothing until they had swiped as many times as the
   * dashboard had re-rendered.
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  /*
   * THE BACK GESTURE HAS TO CLOSE THE SHEET, NOT LEAVE THE TEAM.
   *
   * A sheet is a screen as far as the reader is concerned, and on a phone the
   * way you dismiss a screen is to swipe in from the edge. This component
   * closed on Escape and on a tap outside — neither of which exists as a
   * reflex on iOS, where there is no Escape key at all — so the swipe fell
   * through to the browser and took the whole page with it. Opening a player
   * from the pitch and swiping back left the team entirely.
   *
   * So the sheet takes a history entry while it is open and gives it back when
   * it closes. Three details, each of which is a bug if missed:
   *
   *  - `...window.history.state` is spread rather than replaced. Next keeps its
   *    own routing state there and a bare object breaks its popstate handling.
   *  - Only the TOPMOST dialog acts on a pop, the same rule the Escape handler
   *    above uses: a chip sheet can open a player sheet on top of itself, one
   *    popstate reaches both listeners, and without this both would close.
   *  - `popped` records whether the entry was already consumed by the browser.
   *    Closing by any other route — the X, Escape, a tap outside — has to pop
   *    the entry itself, or the stack grows by one per sheet the reader opens
   *    and the back gesture stops working on the page underneath.
   */
  useEffect(() => {
    /*
     * THE PUSH IS DEFERRED A FRAME, AND THAT IS NOT AN OPTIMISATION.
     *
     * React's development StrictMode mounts every effect, tears it down and
     * mounts it again. Pushing synchronously meant: push, then the teardown's
     * `history.back()`, then push again — and `back()` is asynchronous, so the
     * pop it queues lands AFTER the second mount and is delivered to the new
     * listener, which closes the sheet the reader has just opened. Measured in
     * Chromium against the dev server: the player sheet appeared and vanished
     * within a frame, `[role="dialog"]` never observable, history length up by
     * one and stuck there.
     *
     * Deferring to `requestAnimationFrame` lets the teardown cancel a push that
     * has not happened, so a StrictMode remount costs nothing and the real
     * mount still gets its entry. The cost is that a back gesture inside the
     * first frame is not intercepted, which is not a state a hand can reach.
     */
    let cancelled = false;
    let pushed = false;
    let popped = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      window.history.pushState({ ...window.history.state }, "");
      pushed = true;
    });
    const onPop = () => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      if (dialogs.length > 1 && dialogs[dialogs.length - 1] !== panelRef.current) return;
      popped = true;
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("popstate", onPop);
      if (pushed && !popped) window.history.back();
    };
  }, []);

  useEffect(() => {
    openerRef.current = document.activeElement;
    panelRef.current?.focus();
    /*
     * TAB HAS TO STAY INSIDE THE SHEET.
     *
     * `aria-modal` is a promise to assistive technology, not a mechanism: the
     * browser still lets Tab walk straight out. Confirmed in a browser — four
     * presses left `[role="dialog"]` entirely, and the page behind is neither
     * `inert` nor `aria-hidden`, so a keyboard or screen-reader user ends up
     * operating content they cannot see under a full-screen overlay.
     *
     * The list is recomputed on each Tab rather than cached because these
     * sheets change shape while open — the player sheet swaps its fixture list,
     * the chip sheet reveals a confirm button — and a stale list would trap
     * focus on a control that no longer exists.
     */
    const FOCUSABLE =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      /*
       * ONLY THE TOPMOST SHEET HANDLES THE KEY — EITHER KEY.
       *
       * Both listeners are on `document`, so with two sheets open every press
       * was handled twice. For Tab that pinned focus: the lower sheet yanked it
       * into itself, then the upper one yanked it to ITS first control, making
       * the middle of the top sheet unreachable — worse than no trap, which at
       * least walked through everything.
       *
       * ESCAPE HAD THE SAME SHAPE and was left out of the guard on the reading
       * that letting it through "from either sheet" was generous. It is not: it
       * closed BOTH. WAI-ARIA's dialog pattern is that Escape dismisses the
       * dialog it is in, and here the sheet underneath is a chip scenario that
       * took seconds to compute — so opening a player from it, glancing at his
       * fixtures and pressing Escape threw away the thing the reader was
       * actually looking at. One press, one sheet.
       *
       * It is reachable: a chip sheet's player row opens `PlayerModal` without
       * closing the chip sheet, so the two stack. The topmost is the last
       * `[role="dialog"]` in document order, since React appends on mount.
       */
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      if (dialogs.length > 1 && dialogs[dialogs.length - 1] !== panel) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      /*
       * A SHEET THAT IS NOT ON SCREEN MUST NOT TRAP ANYTHING.
       *
       * These render inside a tab panel, and a slow one can land after the
       * reader has moved tabs: tap a chip badge on Optimize, switch tab while
       * `showChip` is still working, and `setChipView` mounts the sheet into a
       * `hidden` panel. It is 0×0 and invisible — but it is the only
       * `[role="dialog"]` in the document, so the trap below is live, every
       * focusable inside it has `offsetParent === null`, and the "nothing
       * focusable" branch then calls `panel.focus()` on a `display:none`
       * element. Focus lands on `<body>` and stays there.
       *
       * Measured in Chromium: six Tab presses, every one leaving
       * `document.activeElement` as `BODY`, with nothing visible to explain it.
       * Escape is the only way out and the reader has no reason to press it —
       * the keyboard is simply dead. That is strictly worse than the untrapped
       * page this exists to fix, so an unrendered panel gets out of the way.
       */
      if (panel.offsetParent === null) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      // Nothing focusable inside: hold focus on the panel rather than letting
      // Tab escape to the page underneath.
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (active instanceof Node && !panel.contains(active)) {
        // Focus already escaped (a click on the page behind, say) — pull it back.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`w-full ${maxWidth} max-h-[85vh] overflow-y-auto overscroll-contain rounded-t-2xl border border-border-c bg-panel p-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none sm:rounded-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** Uniform close button for sheets — small glyph, 44px hit area. */
export function SheetClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center text-lg text-muted active:text-ink"
    >
      ✕
    </button>
  );
}
