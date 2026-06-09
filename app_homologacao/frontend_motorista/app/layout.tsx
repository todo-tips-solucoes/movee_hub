import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { AuthProvider } from '@/contexts/auth-context';
import { TenantThemeProvider } from '@/contexts/tenant-theme-context';
import { Toaster } from 'sonner';
import { SwUpdater } from '@/components/sw-updater';
import './globals.css';

// Tipografia única do Guia de Marca EntreGô 2.0: Plus Jakarta Sans.
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'EntreGô — App Motorista',
  description: 'Consulte o valor da sua Nota Fiscal e envie o XML para validação.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'EntreGô Motorista',
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon-16.png', type: 'image/png', sizes: '16x16' },
    ],
    apple: '/apple-touch-icon.png',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#2c67ea' },
    { media: '(prefers-color-scheme: dark)', color: '#0a1130' },
  ],
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

// Evita flash de tema errado: aplica .dark antes da pintura, lendo
// localStorage('theme') ou a preferência do sistema.
const themeScript = `(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme:dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={jakarta.variable} suppressHydrationWarning>
      <head>
        {/* Ícones do guia EntreGô: Material Symbols Rounded (wght 500, opsz 40, fill 0) */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@40,500,0,0&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <AuthProvider>
          <TenantThemeProvider>
            {children}
          </TenantThemeProvider>
          <Toaster position="top-center" richColors />
        </AuthProvider>
        <SwUpdater />
      </body>
    </html>
  );
}
