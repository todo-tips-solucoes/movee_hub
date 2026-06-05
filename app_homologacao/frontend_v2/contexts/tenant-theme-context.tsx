'use client';

/**
 * TenantThemeProvider — frontend_v2 (painel EnvioMassa)
 *
 * Feature: config-ui-tenant (White-label por Tenant + Grupo de CNPJs)
 * Ref: docs/specs/config-ui-tenant/contracts/branding-api.md §Mapeamento
 *      docs/specs/config-ui-tenant/spec.md (FR-005, FR-006)
 *
 * Converte as cores HEX do branding (do backend) em valores oklch e injeta
 * como CSS custom properties em :root, sobrescrevendo os tokens shadcn/ui.
 * Respeita o dark mode do next-themes (a injeção é no <html>, que tem a
 * class "dark" gerenciada pelo ThemeProvider).
 *
 * MOVEE_DEFAULTS (dec-028, CHK057): cores padrão usadas quando não há branding.
 * Preview client-only (dec-027, CHK052): estado React, não persiste até Salvar.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface BrandingPayload {
  id_grupo?: number | null;
  logo_url?: string | null;
  cor_primaria?: string | null;
  cor_destaque?: string | null;
  nome_exibicao?: string | null;
  fallback?: 'movee';
}

export interface TenantThemeContextValue {
  branding: BrandingPayload | null;
  loading: boolean;
  /** Preview client-only — não persiste até chamar saveBranding (dec-027) */
  previewBranding: (patch: Partial<BrandingPayload>) => void;
  /** Persiste o branding atual via PUT /empresa/branding */
  saveBranding: (payload: FormData | BrandingPayload) => Promise<void>;
  /** Recarrega branding do servidor */
  refetch: () => Promise<void>;
}

// ── Defaults Movee (dec-028, CHK057) ────────────────────────────────────────

const MOVEE_DEFAULTS: Required<Pick<BrandingPayload, 'cor_primaria' | 'cor_destaque' | 'nome_exibicao'>> = {
  cor_primaria: '#E97316',
  cor_destaque: '#F59E0B',
  nome_exibicao: 'Movee',
};

// ── Conversão HEX → oklch ────────────────────────────────────────────────────
// Implementação client-side sem dependência externa.
// A precisão é suficiente para sobrescrever tokens de UI (não é produção gráfica).

function hexToRgb(hex: string): [number, number, number] | null {
  const cleaned = hex.replace('#', '');
  if (cleaned.length !== 6) return null;
  const r = parseInt(cleaned.slice(0, 2), 16) / 255;
  const g = parseInt(cleaned.slice(2, 4), 16) / 255;
  const b = parseInt(cleaned.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToOklch(r: number, g: number, b: number): string {
  // sRGB → linear
  const rl = linearize(r);
  const gl = linearize(g);
  const bl = linearize(b);

  // linear sRGB → OKLab (matrizes de Björn Ottosson)
  const l_ = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl);
  const m_ = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl);
  const s_ = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl);

  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bv = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  // OKLab → OKLch
  const C = Math.sqrt(a * a + bv * bv);
  const H = (Math.atan2(bv, a) * 180) / Math.PI;
  const hDeg = H < 0 ? H + 360 : H;

  return `oklch(${L.toFixed(4)} ${C.toFixed(4)} ${hDeg.toFixed(2)})`;
}

function hexToOklch(hex: string): string | null {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return rgbToOklch(...rgb);
}

// dec-029, CHK058/059: contraste mínimo 3.0 — calcular luminância relativa
function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(hex1: string, hex2: string): number {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  if (!rgb1 || !rgb2) return 1;
  const L1 = relativeLuminance(...rgb1);
  const L2 = relativeLuminance(...rgb2);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── Injeção de CSS custom properties ────────────────────────────────────────

function applyBrandingTokens(b: BrandingPayload): void {
  const root = document.documentElement;
  const primary = b.cor_primaria || MOVEE_DEFAULTS.cor_primaria;
  const accent = b.cor_destaque || MOVEE_DEFAULTS.cor_destaque;

  const primaryOklch = hexToOklch(primary);
  const accentOklch = hexToOklch(accent);

  if (primaryOklch) {
    root.style.setProperty('--primary', primaryOklch);
    root.style.setProperty('--ring', primaryOklch);
    root.style.setProperty('--sidebar-primary', primaryOklch);
  }
  if (accentOklch) {
    root.style.setProperty('--accent', accentOklch);
    root.style.setProperty('--sidebar-accent', accentOklch);
  }

  // dec-029, CHK058/059: warning se contraste < 3.0 (não bloqueia)
  const bgDark = '#242424';
  const cr = contrastRatio(primary, bgDark);
  if (cr < 3.0) {
    console.warn(
      `[TenantTheme] Contraste de cor_primaria "${primary}" sobre fundo escuro: ${cr.toFixed(2)} < 3.0. ` +
      'Considere uma cor com maior contraste para acessibilidade.'
    );
  }
}

function clearBrandingTokens(): void {
  const root = document.documentElement;
  root.style.removeProperty('--primary');
  root.style.removeProperty('--ring');
  root.style.removeProperty('--sidebar-primary');
  root.style.removeProperty('--accent');
  root.style.removeProperty('--sidebar-accent');
}

// ── Context ──────────────────────────────────────────────────────────────────

const TenantThemeContext = createContext<TenantThemeContextValue | null>(null);

export function TenantThemeProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<BrandingPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBranding = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/empresa/branding', { credentials: 'include' });
      if (!res.ok) {
        clearBrandingTokens();
        setBranding(null);
        return;
      }
      const data: BrandingPayload = await res.json();
      setBranding(data);
      if (!data.fallback) {
        applyBrandingTokens(data);
      } else {
        clearBrandingTokens();
      }
    } catch {
      clearBrandingTokens();
      setBranding(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBranding();
  }, [fetchBranding]);

  // Preview client-only (dec-027, CHK052): atualiza CSS sem persistir
  const previewBranding = useCallback((patch: Partial<BrandingPayload>) => {
    setBranding(prev => {
      const next = { ...(prev ?? {}), ...patch };
      applyBrandingTokens(next);
      return next;
    });
  }, []);

  // Persistir via PUT /empresa/branding (multipart ou JSON)
  const saveBranding = useCallback(async (payload: FormData | BrandingPayload) => {
    const isFormData = payload instanceof FormData;
    const res = await fetch('/api/empresa/branding', {
      method: 'PUT',
      credentials: 'include',
      ...(isFormData
        ? { body: payload }
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erro desconhecido' }));
      throw new Error(err.error || 'Erro ao salvar branding');
    }
    const saved: BrandingPayload = await res.json();
    setBranding(saved);
    if (!saved.fallback) {
      applyBrandingTokens(saved);
    }
  }, []);

  return (
    <TenantThemeContext.Provider
      value={{ branding, loading, previewBranding, saveBranding, refetch: fetchBranding }}
    >
      {children}
    </TenantThemeContext.Provider>
  );
}

export function useTenantTheme(): TenantThemeContextValue {
  const ctx = useContext(TenantThemeContext);
  if (!ctx) {
    throw new Error('useTenantTheme deve ser usado dentro de <TenantThemeProvider>');
  }
  return ctx;
}
