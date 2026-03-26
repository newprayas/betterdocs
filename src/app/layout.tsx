import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "../styles/globals.css";
import "../styles/mobile-touch.css";
import { AppInitializer } from "./AppInitializer";
import SubscriptionModal from "@/components/SubscriptionModal";
import { RouteErrorBoundary } from "@/components/common/RouteErrorBoundary";
import { InstallPrompt } from "@/components/common/InstallPrompt";
import { ThemeProvider } from "@/components/common/ThemeProvider";

export const metadata: Metadata = {
  title: "Meddy - Chat with your books!",
  description: "App to chat with textbooks, guidelines and lecture notes",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Meddy",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icon-192x192.png", sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#020617",
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

import { GlobalLoadingScreen } from "@/components/ui/GlobalLoadingScreen";
import { ServiceWorkerRegister } from "./register-sw";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className="bg-gray-50 text-gray-900 dark:bg-slate-950 dark:text-slate-200 antialiased"
      >
        <Script
          id="theme-init"
          strategy="beforeInteractive"
        >{`(function(){try{var storedTheme=localStorage.getItem('meddy-theme');var theme=storedTheme==='light'?'light':'dark';var root=document.documentElement;root.classList.toggle('dark',theme==='dark');root.classList.toggle('light',theme==='light');var meta=document.querySelector('meta[name="theme-color"]');if(meta){meta.setAttribute('content',theme==='dark'?'#020617':'#f8fafc');}}catch(e){document.documentElement.classList.add('dark');document.documentElement.classList.remove('light');}})();`}</Script>
        <Script
          id="error-suppression"
          strategy="beforeInteractive"
          src="/error-suppression.js"
        />
        <ThemeProvider>
          <RouteErrorBoundary>
            <div id="root" className="min-h-screen flex flex-col">
              <AppInitializer />
              <GlobalLoadingScreen minDisplayTime={1000} />
              <ServiceWorkerRegister />
              <SubscriptionModal />
              <InstallPrompt />
              {children}
            </div>
          </RouteErrorBoundary>
        </ThemeProvider>
      </body>
    </html>
  );
}
