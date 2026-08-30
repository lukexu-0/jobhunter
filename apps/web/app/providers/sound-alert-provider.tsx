"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { ApplicationSessionView, RunDto } from "@jobhunter/pipeline/contracts";
import { SoundAlertController } from "../lib/sound-alerts";

const ENABLED_STORAGE_KEY = "jobhunter.sound-alerts.enabled";

interface SoundAlerts {
  readonly observeRun: (run: RunDto) => void;
  readonly observeApplication: (runId: string, view: ApplicationSessionView) => void;
}

const SoundAlertsContext = createContext<SoundAlerts | null>(null);

export function SoundAlertProvider({ children }: Readonly<{ children: ReactNode }>) {
  const controllerRef = useRef<SoundAlertController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new SoundAlertController();
  const controller = controllerRef.current;

  const observeRun = useCallback((run: RunDto) => {
    controller.observeRun(run);
  }, [controller]);

  const observeApplication = useCallback((runId: string, view: ApplicationSessionView) => {
    controller.observeApplication(runId, view);
  }, [controller]);

  useEffect(() => {
    let enabled = true;
    try {
      enabled = window.localStorage.getItem(ENABLED_STORAGE_KEY) !== "false";
    } catch {
      // The default remains enabled when browser preference storage is unavailable.
    }
    controller.setEnabled(enabled);

    const prime = () => controller.prime();
    document.addEventListener("pointerdown", prime, true);
    document.addEventListener("keydown", prime, true);
    return () => {
      document.removeEventListener("pointerdown", prime, true);
      document.removeEventListener("keydown", prime, true);
      controller.deactivate();
    };
  }, [controller]);

  const value = useMemo(
    () => ({ observeApplication, observeRun }),
    [observeApplication, observeRun],
  );
  return <SoundAlertsContext.Provider value={value}>{children}</SoundAlertsContext.Provider>;
}

export function useSoundAlerts(): SoundAlerts {
  const value = useContext(SoundAlertsContext);
  if (value === null) throw new Error("useSoundAlerts must be used within SoundAlertProvider");
  return value;
}
