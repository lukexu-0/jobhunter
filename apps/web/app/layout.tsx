import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppNavigation } from "./components/app-navigation";
import { DashboardDataProvider } from "./credentials/dashboard-data-provider";
import { AlertProvider } from "./credentials/alert-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resume Tailoring Pipeline",
  description: "Local, evidence-grounded resume tailoring",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AlertProvider>
          <div className="app-shell">
            <AppNavigation />
            <DashboardDataProvider>
              <div className="app-shell__workspace">{children}</div>
            </DashboardDataProvider>
          </div>
        </AlertProvider>
      </body>
    </html>
  );
}
