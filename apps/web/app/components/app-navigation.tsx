"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

function NavIcon({ name }: { readonly name: "applications" | "providers" }): ReactNode {
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
      {name === "applications" ? (
        <>
          <path d="M5 3h9l5 5v13H5V3Z" />
          <path d="M14 3v5h5M8 12h8M8 16h6" />
        </>
      ) : (
        <>
          <path d="M8 3v4M16 3v4M6 7h12v3a6 6 0 0 1-6 6v5M8 21h8" />
        </>
      )}
    </svg>
  );
}

export function AppNavigation(): ReactNode {
  const pathname = usePathname();
  if (pathname.startsWith("/runs/")) return null;
  const applicationsCurrent = pathname === "/";
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
