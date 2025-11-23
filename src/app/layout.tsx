import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import '../styles/globals.css';
import '../styles/mobile-touch.css';
import { AppInitializer } from './AppInitializer';
import SubscriptionModal from '@/components/SubscriptionModal';
import { RouteErrorBoundary } from '@/components/common/RouteErrorBoundary';
import { InstallPrompt } from '@/components/common/InstallPrompt';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Meddy - Chat with Documents Privately',
  description: 'Private RAG chat application for documents',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#020617',
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-slate-950 text-slate-200 antialiased`}>
        <Script
          id="error-suppression"
          strategy="beforeInteractive"
          src="/error-suppression.js"
        />
        <RouteErrorBoundary>
          <div id="root" className="min-h-screen flex flex-col">
            <AppInitializer />
            <SubscriptionModal />
            <InstallPrompt />
            {children}
          </div>
        </RouteErrorBoundary>
      </body>
    </html>
  );
}