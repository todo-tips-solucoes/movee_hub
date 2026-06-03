'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { AuthUser } from '@/types';
import { api } from '@/lib/api-client';

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (nomeEmpresa: string, email: string, senha: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const verifyAuth = useCallback(async () => {
    try {
      const data = await api.get<AuthUser>('/verify-auth');
      if (data.authenticated) {
        setUser(data);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshToken = useCallback(async () => {
    try {
      await api.post('/token/refresh');
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    verifyAuth();
    const interval = setInterval(refreshToken, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [verifyAuth, refreshToken]);

  const login = async (email: string, password: string) => {
    const data = await api.post<AuthUser & { nome_empresa: string }>('/login', { email, password });
    setUser({ authenticated: true, nome_empresa: data.nome_empresa });
    // Re-verify to confirm cookies are working server-side
    try {
      const verified = await api.get<AuthUser>('/verify-auth');
      if (verified.authenticated) {
        setUser(verified);
      }
    } catch {
      // Login response already set user, continue
    }
  };

  const register = async (nomeEmpresa: string, email: string, senha: string) => {
    await api.post('/register', { nomeEmpresa, email, senha });
  };

  const logout = async () => {
    await api.post('/logout');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
