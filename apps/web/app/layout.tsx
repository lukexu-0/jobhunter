import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppNavigation } from "./components/app-navigation";
import { DashboardDataProvider } from "./providers/dashboard-data-provider";
import { SoundAlertProvider } from "./providers/sound-alert-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resume Tailoring Pipeline",
  description: "Local, evidence-grounded resume tailoring",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <SoundAlertProvider>
          <div className="app-shell">
            <AppNavigation />
            <DashboardDataProvider>
              <div className="app-shell__workspace">{children}</div>
            </DashboardDataProvider>
          </div>
        </SoundAlertProvider>
      </body>
    </html>
  );
}
