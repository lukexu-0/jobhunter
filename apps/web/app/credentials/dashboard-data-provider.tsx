"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { AuthStatusResponse } from "../lib/pipeline-contracts";
import { RunCollection, type RunCollectionSnapshot } from "../lib/run-collection";
import { useAlerts } from "./alert-provider";

interface DashboardData extends RunCollectionSnapshot {
  readonly acceptRun: RunCollection["acceptRun"];
  readonly collectCreatedRuns: RunCollection["collectCreatedRuns"];
  readonly acceptRemoval: RunCollection["acceptRemoval"];
  readonly acceptApplicationStarted: RunCollection["acceptApplicationStarted"];
  readonly refreshRuns: RunCollection["refresh"];
  readonly watchJobIdentities: RunCollection["watchJobIdentities"];
  authStatus: AuthStatusResponse | undefined;
  setAuthStatus: Dispatch<SetStateAction<AuthStatusResponse | undefined>>;
}

const DashboardDataContext = createContext<DashboardData | null>(null);

export function DashboardDataProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { observeApplication, observeRun } = useAlerts();
  const [collection] = useState(() => new RunCollection({ observeApplication, observeRun }));
  const snapshot = useSyncExternalStore(collection.subscribe, collection.getSnapshot, collection.getSnapshot);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse>();

  useEffect(() => {
    collection.start();
    return collection.stop;
  }, [collection]);

  const value = useMemo<DashboardData>(() => ({
    ...snapshot,
    acceptRun: collection.acceptRun,
    collectCreatedRuns: collection.collectCreatedRuns,
    acceptRemoval: collection.acceptRemoval,
    acceptApplicationStarted: collection.acceptApplicationStarted,
    refreshRuns: collection.refresh,
    watchJobIdentities: collection.watchJobIdentities,
    authStatus,
    setAuthStatus,
  }), [authStatus, collection, snapshot]);

  return <DashboardDataContext.Provider value={value}>{children}</DashboardDataContext.Provider>;
}

export function useDashboardData(): DashboardData {
  const value = useContext(DashboardDataContext);
  if (!value) throw new Error("useDashboardData must be used within DashboardDataProvider");
  return value;
}
