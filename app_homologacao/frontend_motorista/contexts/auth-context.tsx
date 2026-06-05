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

  // Verificar sessão ao montar
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await api.get<{ authenticated: boolean; cnpjPrestador: string; nome: string }>(
          '/motorista/verify-auth',
        );
        if (!cancelled && data.authenticated) {
          setState({ user: { cnpjPrestador: data.cnpjPrestador, nome: data.nome }, loading: false });
          startRefreshTimer();
        } else if (!cancelled) {
          setState({ user: null, loading: false });
        }
      } catch {
        if (!cancelled) setState({ user: null, loading: false });
      }
    })();

    return () => {
      cancelled = true;
      stopRefreshTimer();
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
    },
    [startRefreshTimer],
  );

  const logout = useCallback(async () => {
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
