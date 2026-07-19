"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { AuthStatusResponse, RunDto } from "@jobhunter/pipeline/contracts";

export interface JobIdentity {
  title: string;
  organization?: string;
}

interface DashboardData {
  runs: RunDto[] | undefined;
  setRuns: Dispatch<SetStateAction<RunDto[] | undefined>>;
  jobIdentities: Record<string, JobIdentity>;
  setJobIdentities: Dispatch<SetStateAction<Record<string, JobIdentity>>>;
  authStatus: AuthStatusResponse | undefined;
  setAuthStatus: Dispatch<SetStateAction<AuthStatusResponse | undefined>>;
}

const DashboardDataContext = createContext<DashboardData | null>(null);

export function DashboardDataProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [runs, setRuns] = useState<RunDto[]>();
  const [jobIdentities, setJobIdentities] = useState<Record<string, JobIdentity>>({});
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse>();
  const value = useMemo(
    () => ({ runs, setRuns, jobIdentities, setJobIdentities, authStatus, setAuthStatus }),
    [authStatus, jobIdentities, runs],
  );

  return <DashboardDataContext.Provider value={value}>{children}</DashboardDataContext.Provider>;
}

export function useDashboardData(): DashboardData {
  const value = useContext(DashboardDataContext);
  if (!value) throw new Error("useDashboardData must be used within DashboardDataProvider");
  return value;
}
