import type { Metadata } from "next";
import { Inter, Poppins, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/contexts/auth-context";
import { TenantThemeProvider } from "@/contexts/tenant-theme-context";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

// Design System Movee — Inter (corpo), Poppins (títulos/display),
// JetBrains Mono (dados numéricos: valores, CNPJ, datas — precisão "fintech").
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-poppins",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Envio em Massa",
  description: "Sistema de envio em massa de documentos fiscais",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      suppressHydrationWarning
      className={`${inter.variable} ${poppins.variable} ${jetbrainsMono.variable}`}
    >
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          {/* AuthProvider acima do TenantThemeProvider: este reage ao login/
              logout/troca de tenant para re-buscar o branding sem hard refresh. */}
          <AuthProvider>
            <TenantThemeProvider>
              <TooltipProvider>
                {children}
                <Toaster richColors position="top-right" />
              </TooltipProvider>
            </TenantThemeProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
