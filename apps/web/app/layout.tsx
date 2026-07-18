import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppNavigation } from "./components/app-navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resume Tailoring Pipeline",
  description: "Local, evidence-grounded resume tailoring",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <AppNavigation />
          <div className="app-shell__workspace">{children}</div>
        </div>
      </body>
    </html>
  );
}
