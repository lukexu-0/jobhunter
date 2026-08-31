"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BellRing, Compass, KeyRound } from "lucide-react";

function NavIcon({ name }: { readonly name: "alerts" | "applications" | "discovery" | "providers" }): ReactNode {
  if (name === "discovery") {
    return <Compass aria-hidden="true" strokeWidth={1.7} />;
  }
  if (name === "alerts") {
    return <BellRing aria-hidden="true" strokeWidth={1.7} />;
  }

  if (name === "providers") {
    return <KeyRound aria-hidden="true" strokeWidth={1.7} />;
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 3h9l5 5v13H5V3Z" />
      <path d="M14 3v5h5M8 12h8M8 16h6" />
    </svg>
  );
}

export function AppNavigationView({ pathname }: { readonly pathname: string }): ReactNode {
  if (pathname.startsWith("/runs/")) return null;
  const applicationsCurrent = pathname === "/";
  const discoveryCurrent = pathname === "/discovery" || pathname.startsWith("/discovery/");
  const alertsCurrent = pathname === "/notifications" || pathname.startsWith("/notifications/");
  const providersCurrent = pathname === "/providers" || pathname.startsWith("/providers/");

  return (
    <header className="app-navigation">
      <nav aria-label="Primary navigation">
        <ul>
          <li>
            <Link href="/" aria-current={applicationsCurrent ? "page" : undefined}>
              <NavIcon name="applications" />
              <span>Applications</span>
            </Link>
          </li>
          <li>
            <Link href="/discovery" aria-current={discoveryCurrent ? "page" : undefined}>
              <NavIcon name="discovery" />
              <span>Discovery</span>
            </Link>
          </li>
          <li>
            <Link href="/notifications" aria-current={alertsCurrent ? "page" : undefined}>
              <NavIcon name="alerts" />
              <span>Alerts</span>
            </Link>
          </li>
          <li>
            <Link href="/providers" aria-current={providersCurrent ? "page" : undefined}>
              <NavIcon name="providers" />
              <span>Providers</span>
            </Link>
          </li>
        </ul>
      </nav>
    </header>
  );
}

export function AppNavigation(): ReactNode {
  return <AppNavigationView pathname={usePathname()} />;
}
