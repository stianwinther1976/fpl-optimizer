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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
