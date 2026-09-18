/**
 * adiantamento-motorista — lib/auth-sessao.ts (tasks.md 6.7.1, 6.7.2)
 *
 * Lógica PURA (sem I/O) de restauração de sessão, com as duas dependências
 * de rede injetadas — testável por `node --test` sem tocar
 * `contexts/auth-context.tsx` (que mexe em sessão já em produção).
 *
 * Sequência (contracts/motorista-api.md "Mudanças em contratos existentes":
 * "Com 401 no /verify-auth, tenta POST /motorista/token/refresh uma vez
 * antes de ir ao login" — FR-053):
 *   1. `verificarAuth()` — se autenticado, é a sessão (equivalente ao login
 *      já feito).
 *   2. Se falhar (access expirado/ausente), tenta `renovarToken()` UMA vez.
 *   3. Se o refresh também falhar (refresh expirado — CHK003), sessão nula:
 *      quem chama decide ir para o login, sem loop e sem mensagem de erro
 *      (silencioso, mesmo padrão de `app/(app)/layout.tsx` — FR-053/6.7.2).
 *   4. Se o refresh funcionar, repete `verificarAuth()` uma vez.
 */

export interface MotoristaUser {
  cnpjPrestador: string;
  nome: string;
}

interface RespostaVerifyAuth {
  authenticated: boolean;
  cnpjPrestador: string;
  nome: string;
}

export interface DepsRestaurarSessao {
  verificarAuth: () => Promise<RespostaVerifyAuth>;
  renovarToken: () => Promise<void>;
}

function paraUser(data: RespostaVerifyAuth): MotoristaUser | null {
  return data.authenticated ? { cnpjPrestador: data.cnpjPrestador, nome: data.nome } : null;
}

export async function restaurarSessao(deps: DepsRestaurarSessao): Promise<MotoristaUser | null> {
  try {
    return paraUser(await deps.verificarAuth());
  } catch {
    // access expirado/ausente — tenta refresh silencioso uma única vez.
  }

  try {
    await deps.renovarToken();
  } catch {
    return null; // refresh também expirado/inválido: sessão nula, sem loop.
  }

  try {
    return paraUser(await deps.verificarAuth());
  } catch {
    return null;
  }
}
