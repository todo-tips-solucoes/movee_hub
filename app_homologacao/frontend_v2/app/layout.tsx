import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/contexts/auth-context";
import { TenantThemeProvider } from "@/contexts/tenant-theme-context";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

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
    <html lang="pt-BR" suppressHydrationWarning className={geist.variable}>
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          <TenantThemeProvider>
            <TooltipProvider>
              <AuthProvider>
                {children}
                <Toaster richColors position="top-right" />
              </AuthProvider>
            </TooltipProvider>
          </TenantThemeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
