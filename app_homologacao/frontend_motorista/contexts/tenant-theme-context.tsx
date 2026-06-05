'use client';

/**
 * TenantThemeProvider — frontend_motorista (PWA)
 *
 * Feature: config-ui-tenant (White-label por Tenant + Grupo de CNPJs)
 * Ref: docs/specs/config-ui-tenant/contracts/branding-api.md §GET /motorista/branding-tomador
 *      docs/specs/config-ui-tenant/spec.md (FR-007, FR-008)
 *
 * Diferença do frontend_v2: este provider usa HEX diretamente (globals.css usa HEX,
 * não oklch). Cache Map<cnpj_tomador, payload> com TTL=sessão (dec-031, CHK066).
 * Timeout client-side: 3000ms (dec-024, CHK038).
 * Fallback: { fallback: "movee" } → aplica MOVEE_DEFAULTS sem sobrescrever tokens.
 *
 * Logo: h-6 max-w-24 (dec-030, CHK062 — dimensões para o header do motorista).
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface BrandingPayload {
  logo_url?: string | null;
  cor_primaria?: string | null;
  cor_destaque?: string | null;
  nome_exibicao?: string | null;
  fallback?: 'movee';
}

export interface TenantThemeContextValue {
  /**
   * Aplica o branding do tomador de um movimento.
   * Faz a chamada ao backend (com cache TTL=sessão por cnpj_tomador),
   * injeta os tokens CSS e retorna o payload.
   */
  applyBrandingForMovimento: (
    movimentoId: number,
    cnpjTomador: string | null
  ) => Promise<BrandingPayload | null>;
  /** Limpa o branding atual e volta aos defaults Movee */
  clearBranding: () => void;
}

// ── Defaults Movee (dec-028, CHK057) ────────────────────────────────────────

const MOVEE_DEFAULTS: BrandingPayload = {
  cor_primaria: '#1f63eb',
  cor_destaque: '#ff7a18',
  nome_exibicao: 'Movee',
};

// ── Injeção de CSS custom properties (HEX direto — globals.css usa HEX) ─────

function applyTokensHex(b: BrandingPayload): void {
  const root = document.documentElement;
  const primary = b.cor_primaria || MOVEE_DEFAULTS.cor_primaria!;
  const accent = b.cor_destaque || MOVEE_DEFAULTS.cor_destaque!;

  root.style.setProperty('--primary', primary);
  root.style.setProperty('--ring', primary);
  // warm-2 é o ponto médio do gradiente assinatura Movee
  root.style.setProperty('--warm-2', accent);
}

function clearTokens(): void {
  const root = document.documentElement;
  root.style.removeProperty('--primary');
  root.style.removeProperty('--ring');
  root.style.removeProperty('--warm-2');
}

// ── Context ──────────────────────────────────────────────────────────────────

const TenantThemeContext = createContext<TenantThemeContextValue | null>(null);

export function TenantThemeProvider({ children }: { children: ReactNode }) {
  // Cache Map<cnpj_tomador, BrandingPayload | null> — TTL=sessão (dec-031)
  const cacheRef = useRef<Map<string, BrandingPayload | null>>(new Map());

  const clearBranding = useCallback(() => {
    clearTokens();
  }, []);

  const applyBrandingForMovimento = useCallback(
    async (
      movimentoId: number,
      cnpjTomador: string | null
    ): Promise<BrandingPayload | null> => {
      // Chave de cache: cnpjTomador (normalizado) ou fallback por movimentoId
      const cacheKey = cnpjTomador
        ? String(cnpjTomador).replace(/\D/g, '')
        : `mov_${movimentoId}`;

      // Cache hit
      if (cacheRef.current.has(cacheKey)) {
        const cached = cacheRef.current.get(cacheKey) ?? null;
        if (cached && !cached.fallback) {
          applyTokensHex(cached);
        } else {
          clearTokens();
        }
        return cached;
      }

      // Chamada ao backend com timeout 3000ms (dec-024, CHK038)
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const res = await fetch(
          `/api/motorista/branding-tomador?movimento=${movimentoId}`,
          { credentials: 'include', signal: controller.signal }
        );
        clearTimeout(timeoutId);

        if (!res.ok) {
          // Falha HTTP → fallback Movee (não expõe erro para o PWA)
          cacheRef.current.set(cacheKey, null);
          clearTokens();
          return null;
        }

        const data: BrandingPayload = await res.json();

        // Fallback explícito do backend
        if (data.fallback === 'movee') {
          cacheRef.current.set(cacheKey, data);
          clearTokens();
          return data;
        }

        // Branding real: aplicar tokens e cachear
        cacheRef.current.set(cacheKey, data);
        applyTokensHex(data);
        return data;
      } catch {
        // Timeout (AbortError) ou falha de rede → fallback silencioso
        cacheRef.current.set(cacheKey, null);
        clearTokens();
        return null;
      }
    },
    []
  );

  return (
    <TenantThemeContext.Provider value={{ applyBrandingForMovimento, clearBranding }}>
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
