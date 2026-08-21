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
