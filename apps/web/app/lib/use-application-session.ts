"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ApplicationSessionView } from "./pipeline-contracts";
import {
  createApplicationSession,
  INITIAL_APPLICATION_SESSION,
  type ApplicationDispatchResult,
  type ApplicationSession,
  type ApplicationSessionAction,
  type ApplicationSessionRun,
} from "./application-session";

const emptySubscribe = () => () => {};
const initialSnapshot = () => INITIAL_APPLICATION_SESSION;

/** React owns the lifetime; the session module owns all workflow coordination. */
export function useApplicationSession(
  run: ApplicationSessionRun,
  onView: (view: ApplicationSessionView | null) => void,
) {
  const context = `${run.id}:${run.revision}`;
  const current = useRef({ context, run, onView });
  current.current = { context, run, onView };
  const [binding, setBinding] = useState<{
    context: string;
    session: ApplicationSession;
  } | null>(null);
  const active = useRef<ApplicationSession | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const session = createApplicationSession(current.current.run, {
      signal: controller.signal,
      onView: (view) => {
        if (current.current.context === context) current.current.onView(view);
      },
    });
    active.current = session;
    setBinding({ context, session });
    return () => {
      controller.abort();
      if (active.current === session) active.current = null;
    };
  }, [context]);
  useEffect(() => {
    active.current?.updateRun(run);
  }, [run.id, run.revision, run.status, run.currentPdfSha256]);
  const session = binding?.context === context ? binding.session : null;
  const state = useSyncExternalStore(
    session?.subscribe ?? emptySubscribe,
    session?.getSnapshot ?? initialSnapshot,
    initialSnapshot,
  );
  const dispatch = useCallback((action: ApplicationSessionAction): Promise<ApplicationDispatchResult> => {
    if (current.current.context !== context || !active.current) {
      return Promise.resolve({
        status: "rejected",
        message: "The application state changed; review the latest session state.",
      });
    }
    return active.current.dispatch(action);
  }, [context]);
  return { state, dispatch };
}
