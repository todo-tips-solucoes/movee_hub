'use client';

// hub-shell (S3) task 1.4 — provider de autenticação do HUB.
//
// Distinto e independente do `contexts/auth-context.tsx` legado (envio em
// massa, fala com o backend legado via `/api/verify-auth`/`/api/login`). Este
// provider fala com `/api/v1/auth/*` e `/api/v1/me` (fundação S2,
// routes/hub-auth.js + routes/hub-me.js). NENHUMA linha do legado é
// tocada por este arquivo (FR-018/SC-007, research.md D4).
//
// Ref: docs/specs/hub-shell/plan.md §3.1, docs/specs/hub-shell/research.md D4/D7.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { toHubMe, toTrocarEntidadeReq, type HubMe, type MeResponseDTO } from '@/lib/hub/me-dto';

const HUB_API_BASE = '/api/v1';

/**
 * Erro de chamada à API do hub. `status` HTTP é o discriminador confiável.
 *
 * Achado desta onda (task 1.4, leitura de `hub-auth.js`/`hub-me.js`): o
 * backend NUNCA emite um código-enum no campo `erro` — sempre uma mensagem
 * humana em português (ex.: `{"erro":"E-mail ou senha inválidos."}`). Isso
 * diverge do que `docs/specs/hub-fundacoes/contracts/auth.md` descreve como
 * "Code" (`CREDENCIAIS_INVALIDAS`/`CONTA_BLOQUEADA`/`RATE_LIMIT`) — na
 * prática esses "códigos" são categorias derivadas do STATUS HTTP, não um
 * valor literal no corpo. Consumidores desta API (ex.: tela de login, task
 * 4.1) DEVEM discriminar por `status` (401/423/429 para login;
 * 400/403 para troca de entidade) e usar `message` só como texto de exibição
 * de fallback — nunca fazer `switch` sobre uma string de código que o
 * backend não envia.
 */
export class HubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HubApiError';
  }
}

async function hubFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HUB_API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const mensagem =
      body && typeof body === 'object' && 'erro' in body && typeof (body as { erro: unknown }).erro === 'string'
        ? (body as { erro: string }).erro
        : `Erro ${res.status}`;
    throw new HubApiError(res.status, mensagem);
  }
  return body as T;
}

interface HubAuthContextValue {
  usuario: HubMe['usuario'] | null;
  entidades: HubMe['entidades'];
  entidadeAtiva: number | null;
  modulos: HubMe['modulos'];
  permissoes: string[];
  carregando: boolean;
  login: (email: string, senha: string) => Promise<void>;
  logout: () => Promise<void>;
  trocarEntidade: (empresaId: number) => Promise<void>;
  refetchMe: () => Promise<void>;
  // task 4.2/4.3 — reuso do fluxo único de recuperação/redefinição de senha
  // (dec-030: também aciona o "trocar senha" do perfil, task 4.4, sem
  // endpoint novo de backend). Resposta SEMPRE `{ ok, mensagem }` — o
  // backend nunca revela se o e-mail existe (FR-020/SC-005).
  recuperarSenha: (email: string) => Promise<{ ok: boolean; mensagem: string }>;
  redefinirSenha: (token: string, novaSenha: string) => Promise<void>;
}

const HubAuthContext = createContext<HubAuthContextValue | null>(null);

export function HubAuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<HubMe | null>(null);
  const [carregando, setCarregando] = useState(true);

  // Guard de rota (D7/dec-009): cada chamada reflete perda de vínculo
  // (FR-015) e expiração de sessão — 401/erro de rede degradam para
  // deslogado (me=null) SEM lançar, para não derrubar a árvore de
  // componentes que consome o contexto.
  const refetchMe = useCallback(async () => {
    try {
      const dto = await hubFetch<MeResponseDTO>('/me');
      setMe(toHubMe(dto));
    } catch {
      setMe(null);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    refetchMe();
  }, [refetchMe]);

  const login = useCallback(
    async (email: string, senha: string) => {
      // Propaga HubApiError (401/423/429) para o chamador (tela de login,
      // task 4.1) decidir a mensagem — não mascarado aqui.
      await hubFetch<{ usuario: { id: number; email: string; nome: string } }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, senha }),
      });
      await refetchMe();
    },
    [refetchMe]
  );

  const logout = useCallback(async () => {
    try {
      await hubFetch<{ ok: boolean }>('/auth/logout', { method: 'POST' });
    } finally {
      // Logout é resiliente por design (mesmo padrão do backend, FR-018):
      // mesmo se a chamada falhar, o estado local é limpo.
      setMe(null);
    }
  }, []);

  // task 4.5.3 — requisição *in-flight* de uma ação autenticada que recebe
  // 401 (sessão expira em meio a uma ação, ex.: troca de entidade): limpa o
  // estado IMEDIATAMENTE (não espera o próximo refetchMe do guard de rota,
  // components/hub/session-guard.tsx), para não expor dados de uma sessão
  // morta a uma próxima pessoa no mesmo dispositivo (edge case CHK017).
  // NÃO usado por login/recuperarSenha/redefinirSenha: nessas, 401/400/410
  // são desfechos de negócio (credencial inválida/token inválido), não
  // "sessão expirou" — não há sessão para limpar.
  const authenticatedFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    try {
      return await hubFetch<T>(path, init);
    } catch (e) {
      if (e instanceof HubApiError && e.status === 401) {
        setMe(null);
      }
      throw e;
    }
  }, []);

  const trocarEntidade = useCallback(
    async (empresaId: number) => {
      // 400 EMPRESA_ID_INVALIDO / 403 SEM_VINCULO (task 3.1.4): propaga o
      // erro SEM chamar refetchMe() — `me` permanece com a entidade anterior
      // selecionada, a sessão não quebra. 401 (sessão expirada em meio à
      // troca) é tratado por `authenticatedFetch` acima.
      await authenticatedFetch<{ entidade_ativa: number }>('/me/entidade', {
        method: 'POST',
        body: JSON.stringify(toTrocarEntidadeReq(empresaId)),
      });
      await refetchMe();
    },
    [authenticatedFetch, refetchMe]
  );

  const recuperarSenha = useCallback(async (email: string) => {
    // Sem 401 possível aqui (rota pública, sem sessão) — só 200/429.
    return hubFetch<{ ok: boolean; mensagem: string }>('/auth/recuperar-senha', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }, []);

  const redefinirSenha = useCallback(async (token: string, novaSenha: string) => {
    // Propaga HubApiError (400 token/senha ausentes ou curtos, 400 token
    // inválido, 410 token expirado) para o chamador (tela de redefinir
    // senha, task 4.3) decidir a mensagem.
    await hubFetch<{ ok: boolean }>('/auth/redefinir-senha', {
      method: 'POST',
      body: JSON.stringify({ token, nova_senha: novaSenha }),
    });
  }, []);

  const value: HubAuthContextValue = {
    usuario: me ? me.usuario : null,
    entidades: me ? me.entidades : [],
    entidadeAtiva: me ? me.entidadeAtiva : null,
    modulos: me ? me.modulos : [],
    permissoes: me ? me.permissoes : [],
    carregando,
    login,
    logout,
    trocarEntidade,
    refetchMe,
    recuperarSenha,
    redefinirSenha,
  };

  return <HubAuthContext.Provider value={value}>{children}</HubAuthContext.Provider>;
}

export function useHubAuth() {
  const ctx = useContext(HubAuthContext);
  if (!ctx) throw new Error('useHubAuth must be used within HubAuthProvider');
  return ctx;
}
