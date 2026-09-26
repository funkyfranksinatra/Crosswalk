"use client";
import { useEffect, type RefObject } from "react";

/**
 * Close a popover or menu on Escape and on a click outside it. Keyboard users get the same
 * exit as mouse users, and focus goes back to the element that opened it when one is given.
 */
export function useDismiss(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>, restoreTo?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); restoreTo?.current?.focus(); } };
    const onDown = (e: MouseEvent) => { const t = e.target as Node; if (restoreTo?.current?.contains(t)) return; if (ref.current && !ref.current.contains(t)) onClose(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [open, onClose, ref, restoreTo]);
}
