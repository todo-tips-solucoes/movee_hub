import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/contexts/auth-context';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'App Motorista — Validação de NF',
  description: 'Consulte o valor da sua Nota Fiscal e envie o XML para validação.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'App Motorista',
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
      </head>
      <body className="min-h-dvh bg-background text-foreground">
        <AuthProvider>
          {children}
          <Toaster position="top-center" richColors />
        </AuthProvider>
      </body>
    </html>
  );
}
