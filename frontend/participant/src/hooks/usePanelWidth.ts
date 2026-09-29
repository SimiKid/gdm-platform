import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const PANEL_WIDTH_KEY = "gdm-panel-width";
const PANEL_MIN = 280;
const PANEL_MAX = 640;

/** Keep the panel usable and leave the chat column at least ~360px. */
export function clampPanelWidth(w: number): number {
  const max = Math.min(PANEL_MAX, window.innerWidth - 360);
  return Math.max(PANEL_MIN, Math.min(w, Math.max(PANEL_MIN, max)));
}

/** Width of the resizable study side panel (persisted across reloads). */
export function usePanelWidth() {
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return saved ? clampPanelWidth(saved) : 340;
  });

  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

  function startPanelResize(e: ReactPointerEvent) {
    e.preventDefault();
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: PointerEvent) =>
      setPanelWidth(clampPanelWidth(window.innerWidth - ev.clientX));
    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** Keyboard resizing: ArrowLeft widens the panel, ArrowRight narrows it. */
  function resizeBy(deltaPx: number) {
    setPanelWidth((w) => clampPanelWidth(w + deltaPx));
  }

  return { panelWidth, startPanelResize, resizeBy };
}
