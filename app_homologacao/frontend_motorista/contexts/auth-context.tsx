'use client';

/**
 * AuthContext para o App Motorista PWA.
 * Adaptado do frontend_v2 — usa /api/motorista/* em vez de /api/*.
 * Refresh automático a cada 10 minutos (token expira em 15m).
 * Ref: tarefa 4.1.3 / spec FR-001 / contracts §verify-auth / §refresh
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api } from '@/lib/api-client';
import { restaurarSessao } from '@/lib/auth-sessao';
import { revogar as revogarPush, sincronizar as sincronizarPush } from '@/lib/push';

// ──────────────────────────────────────────────────────────────────────────────
// Tipos
// ──────────────────────────────────────────────────────────────────────────────
interface MotoristaUser {
  cnpjPrestador: string;
  nome: string;
}

interface AuthState {
  user: MotoristaUser | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (cnpjPrestador: string, senha: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Context
// ──────────────────────────────────────────────────────────────────────────────
const AuthContext = createContext<AuthContextValue | null>(null);

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutos

// ──────────────────────────────────────────────────────────────────────────────
// Provider
// ──────────────────────────────────────────────────────────────────────────────
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const refreshToken = useCallback(async (): Promise<boolean> => {
    try {
      await api.post('/motorista/token/refresh');
      return true;
    } catch {
      return false;
    }
  }, []);

  const startRefreshTimer = useCallback(() => {
    stopRefreshTimer();
    refreshTimerRef.current = setInterval(async () => {
      const ok = await refreshToken();
      if (!ok) {
        setState({ user: null, loading: false });
        stopRefreshTimer();
      }
    }, REFRESH_INTERVAL_MS);
  }, [refreshToken, stopRefreshTimer]);

  // Verificar sessão ao montar — restaura silenciosamente com refresh (uma
  // tentativa) antes de desistir (tasks.md 6.7.1/6.7.2, FR-053, CHK003):
  // lógica pura em lib/auth-sessao.ts, testada isoladamente.
  //
  // tasks.md 11.24/FR-053: o setInterval de refresh (abaixo) não dispara com
  // o PWA suspenso em background (timers de página congelam); ao voltar ao
  // primeiro plano com o access token (15min) já vencido, a tela ficava
  // presa em "Não autorizado" até um reload completo — nenhuma tela
  // reabre com uma tentativa de restauração. `visibilitychange` é o sinal
  // nativo de "o motorista reabriu a tela", então repete a mesma
  // restauração silenciosa nesse gatilho, sem recarregar a página.
  useEffect(() => {
    let cancelled = false;

    const verificarSessao = () =>
      restaurarSessao({
        verificarAuth: () =>
          api.get<{ authenticated: boolean; cnpjPrestador: string; nome: string }>('/motorista/verify-auth'),
        renovarToken: () => api.post('/motorista/token/refresh'),
      }).then((user) => {
        if (cancelled) return;
        setState({ user, loading: false });
        if (user) {
          startRefreshTimer();
          // push-motorista (tasks.md 6.3.1/FR-008) — a cada abertura autenticada,
          // sem pedir permissão de novo (no-op se ainda não concedida).
          sincronizarPush();
        } else {
          stopRefreshTimer();
        }
      });

    verificarSessao();

    const aoVoltarAoPrimeiroPlano = () => {
      if (document.visibilityState === 'visible') verificarSessao();
    };
    document.addEventListener('visibilitychange', aoVoltarAoPrimeiroPlano);

    return () => {
      cancelled = true;
      stopRefreshTimer();
      document.removeEventListener('visibilitychange', aoVoltarAoPrimeiroPlano);
    };
  }, [startRefreshTimer, stopRefreshTimer]);

  const login = useCallback(
    async (cnpjPrestador: string, senha: string) => {
      const data = await api.post<{ cnpjPrestador: string; nome: string }>('/motorista/login', {
        cnpjPrestador,
        senha,
      });
      setState({ user: { cnpjPrestador: data.cnpjPrestador, nome: data.nome }, loading: false });
      startRefreshTimer();
      // push-motorista (tasks.md 6.3.1/FR-008) — mesmo gatilho de "abertura autenticada".
      sincronizarPush();
    },
    [startRefreshTimer],
  );

  const logout = useCallback(async () => {
    // push-motorista (tasks.md 6.3.2/FR-009) — revoga ANTES do logout. Best-effort
    // (lib/push.ts#revogar nunca lança): uma falha aqui não pode impedir o logout.
    await revogarPush();
    try {
      await api.post('/motorista/logout');
    } catch {
      // Ignorar erros de logout (cookie pode já ter expirado)
    } finally {
      setState({ user: null, loading: false });
      stopRefreshTimer();
    }
  }, [stopRefreshTimer]);

  return (
    <AuthContext.Provider value={{ ...state, login, logout, refreshToken }}>
      {children}
    </AuthContext.Provider>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────────────────────────────────────
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
  return ctx;
}
