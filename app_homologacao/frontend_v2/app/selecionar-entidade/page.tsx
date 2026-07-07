'use client';

// hub-shell (S3) task 3.2 — rota /selecionar-entidade: os 3 ramos pós-login
// por quantidade de vínculos (spec.md FR-003/FR-004/FR-016, plan.md §3.4):
//   - entidades.length > 1  -> tela de escolha explícita (FR-003)
//   - entidades.length === 1 -> seleciona automaticamente e segue /dashboard,
//     sem exigir escolha manual (FR-004)
//   - entidades.length === 0 -> tela dedicada "sem acesso" (FR-016)
//
// A troca em si (POST /me/entidade + refetchMe) é 100% delegada a
// `trocarEntidade()` do HubAuthProvider (mesmo contrato usado pelo
// EntitySwitcher, components/hub/entity-switcher.tsx) — nenhuma lógica nova
// de rede aqui.
//
// Ref: docs/specs/hub-shell/plan.md §3.4, spec.md FR-003/FR-004/FR-016.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Building2, Loader2, LogOut } from 'lucide-react';
import { useHubAuth, HubApiError } from '@/contexts/hub-auth-context';
import { labelVinculo } from '@/components/hub/entity-switcher';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// dec-039/dec-041 (Fase 4): namespace /hub/ evita colisão com o envio-massa
// legado (app/dashboard/page.tsx + subrotas reais motoristas/configuracoes/
// validacao-xml). Ver lib/hub/module-nav.ts para a mesma convenção aplicada
// ao ModuleNav.
const DASHBOARD_ROUTE = '/hub/dashboard';
const LOGIN_ROUTE = '/hub/login';

type Ramo = 'carregando' | 'sem-acesso' | 'auto-selecao' | 'escolha';

/**
 * Lógica dos 3 ramos, isolada do JSX — testável sem depender de
 * mocks profundos de roteamento/portal (mesmo espírito de
 * `useEntitySwitcher` em `components/hub/entity-switcher.tsx`).
 */
export function useSelecionarEntidade() {
  const { entidades, entidadeAtiva, carregando, trocarEntidade } = useHubAuth();
  const router = useRouter();
  const [selecionando, setSelecionando] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const autoSelecaoDisparada = useRef(false);

  const ramo: Ramo = carregando
    ? 'carregando'
    : entidades.length === 0
      ? 'sem-acesso'
      : entidades.length === 1
        ? 'auto-selecao'
        : 'escolha';

  const selecionar = useCallback(
    async (empresaId: number) => {
      setSelecionando(empresaId);
      setErro(null);
      try {
        // Idempotente: se já é a entidade ativa (ex.: retorno a esta rota
        // depois de já selecionada), pula o POST desnecessário.
        if (empresaId !== entidadeAtiva) {
          await trocarEntidade(empresaId);
        }
        router.replace(DASHBOARD_ROUTE);
      } catch (e) {
        // FR-006/dec: recusa (400/403) mantém a entidade anterior e NÃO
        // navega — permanece nesta tela com o erro visível.
        setErro(
          e instanceof HubApiError
            ? e.message
            : 'Não foi possível selecionar a entidade. Tente novamente.'
        );
        setSelecionando(null);
      }
    },
    [entidadeAtiva, trocarEntidade, router]
  );

  // FR-004/task 3.2.2: exatamente 1 vínculo -> seleciona automaticamente,
  // sem exigir escolha manual. Dispara uma única vez por montagem (guard via
  // ref) para não repetir a chamada a cada re-render.
  useEffect(() => {
    if (ramo === 'auto-selecao' && !autoSelecaoDisparada.current) {
      autoSelecaoDisparada.current = true;
      // Disparado via microtask: `selecionar` atualiza estado local
      // (`selecionando`) antes de qualquer `await` — adiar a chamada tira-a
      // do corpo síncrono do efeito (react-hooks/set-state-in-effect),
      // preservando a semântica de "efeito colateral externo assíncrono
      // disparado ao montar" (a chamada de rede real via trocarEntidade()).
      queueMicrotask(() => {
        void selecionar(entidades[0].empresaId);
      });
    }
  }, [ramo, entidades, selecionar]);

  return { ramo, entidades, entidadeAtiva, selecionando, erro, selecionar };
}

function TelaCarregando() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3" role="status">
      <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="text-sm text-muted-foreground">Carregando…</span>
    </div>
  );
}

function TelaAutoSelecao() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3" role="status">
      <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="text-sm text-muted-foreground">Selecionando sua entidade…</span>
    </div>
  );
}

function TelaSemAcesso() {
  const { logout } = useHubAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.replace(LOGIN_ROUTE);
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <AlertTriangle className="mb-2 size-10 text-warning" aria-hidden="true" />
          <CardTitle as="h1">Sem acesso a nenhuma entidade</CardTitle>
          <CardDescription>
            Sua conta está autenticada, mas não possui vínculo ativo com nenhuma entidade no
            momento. Fale com um administrador para solicitar acesso.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center px-4">
          <Button variant="outline" onClick={handleLogout}>
            <LogOut className="size-4" aria-hidden="true" />
            Sair
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function TelaEscolha({
  entidades,
  selecionando,
  erro,
  selecionar,
}: Pick<
  ReturnType<typeof useSelecionarEntidade>,
  'entidades' | 'selecionando' | 'erro' | 'selecionar'
>) {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle as="h1">Selecionar entidade</CardTitle>
          <CardDescription>
            Você tem acesso a mais de uma entidade. Escolha com qual deseja trabalhar.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-4">
          {erro && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
            >
              {erro}
            </p>
          )}
          {entidades.map((vinculo) => {
            const trocandoEsta = selecionando === vinculo.empresaId;
            return (
              <Button
                key={vinculo.empresaId}
                variant="outline"
                className="min-h-11 w-full justify-start gap-2"
                disabled={selecionando !== null}
                onClick={() => selecionar(vinculo.empresaId)}
              >
                {trocandoEsta ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                ) : (
                  <Building2 className="size-4 shrink-0" aria-hidden="true" />
                )}
                {labelVinculo(vinculo)}
              </Button>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

export default function SelecionarEntidadePage() {
  const { ramo, entidades, selecionando, erro, selecionar } = useSelecionarEntidade();

  if (ramo === 'carregando') return <TelaCarregando />;
  if (ramo === 'sem-acesso') return <TelaSemAcesso />;
  if (ramo === 'auto-selecao') return <TelaAutoSelecao />;
  return (
    <TelaEscolha
      entidades={entidades}
      selecionando={selecionando}
      erro={erro}
      selecionar={selecionar}
    />
  );
}
