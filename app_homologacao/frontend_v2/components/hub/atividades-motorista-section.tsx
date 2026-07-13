// hub-motorista-canonico (FASE 6) — seção "Atividades" do detalhe do
// motorista (tasks.md 6.5, contracts/api-motorista-canonico.md §GET
// /motoristas/:id enriquecido). Read-only (sem NENHUMA ação de edição na
// lista, FR-022) — histórico correlacionado por uuid (faturamento,
// performance, validação de NF), ordenado desc por data, paginação técnica
// "carregar mais" sobre offset/limit (dec-046).
//
// A11y (Gap CHK006/CHK039, task 6.5.3): lista semântica (`<ul>`/`<li>`),
// botão "Carregar mais" é um `<button>` nativo — Tab/Enter/Espaço já
// funcionam sem JS extra; `aria-busy` no botão durante o fetch; a lista usa
// `aria-live="polite"` para leitores de tela anunciarem itens novos
// carregados sem precisar de foco explícito — mesmo espírito dos outros
// componentes Base UI reaproveitados nesta feature (perfil-dialog.tsx,
// entregador-combobox.tsx): navegação por teclado completa + rótulos ARIA.

import { useCallback, useState } from 'react';
import { AlertCircle, History, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/hub/empty-state';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { TipoAtividadeBadge } from '@/components/hub/status-badge';
import { obterMotorista, MotoristaApiError } from '@/lib/hub/motoristas-api';
import type { Atividade, AtividadesPaginadas } from '@/lib/hub/motoristas-dto';
import { formatBRL, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 20;

/** Lógica isolada do JSX (mesmo padrão de `useMotoristaDetalhe`/`usePerfil`).
 * Acumula páginas via "carregar mais" — cada chamada busca o detalhe
 * completo (endpoint compartilhado) mas só os itens de `atividades` são
 * anexados ao estado local. */
export function useAtividadesMotorista(id: number, atividadesIniciais: AtividadesPaginadas) {
  const [items, setItems] = useState<Atividade[]>(atividadesIniciais.items);
  const [total, setTotal] = useState(atividadesIniciais.total);
  const [offset, setOffset] = useState(atividadesIniciais.offset + atividadesIniciais.items.length);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const reiniciar = useCallback((atividades: AtividadesPaginadas) => {
    setItems(atividades.items);
    setTotal(atividades.total);
    setOffset(atividades.offset + atividades.items.length);
    setErro(null);
  }, []);

  const carregarMais = useCallback(async () => {
    if (carregandoMais) return;
    setCarregandoMais(true);
    setErro(null);
    try {
      const resposta = await obterMotorista(id, { atividadesOffset: offset, atividadesLimit: PAGE_SIZE });
      setItems((prev) => [...prev, ...resposta.atividades.items]);
      setTotal(resposta.atividades.total);
      setOffset(offset + resposta.atividades.items.length);
    } catch (e) {
      setErro(e instanceof MotoristaApiError ? e.message : 'Não foi possível carregar mais atividades.');
    } finally {
      setCarregandoMais(false);
    }
  }, [id, offset, carregandoMais]);

  const temMais = items.length < total;

  return { items, total, temMais, carregandoMais, erro, carregarMais, reiniciar };
}

function LinhaAtividade({ atividade }: { atividade: Atividade }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <TipoAtividadeBadge tipo={atividade.tipo} />
        <span className="text-muted-foreground">{formatDateBR(atividade.data) || '-'}</span>
        {atividade.descricao && <span className="truncate">{atividade.descricao}</span>}
      </div>
      {atividade.valor != null && <span className="font-mono font-medium">{formatBRL(atividade.valor)}</span>}
    </li>
  );
}

interface AtividadesMotoristaSectionProps {
  carregandoDetalhe: boolean;
  state: ReturnType<typeof useAtividadesMotorista>;
}

/** Seção "Atividades" — SEM nenhuma ação de edição (read-only, FR-022). */
export function AtividadesMotoristaSection({ carregandoDetalhe, state }: AtividadesMotoristaSectionProps) {
  const { items, total, temMais, carregandoMais, erro, carregarMais } = state;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-base">
          Atividades
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {carregandoDetalhe ? (
          <ListSkeleton label="Carregando atividades..." linhas={3} />
        ) : items.length === 0 ? (
          <EmptyState
            icone={History}
            titulo="Nenhuma atividade registrada"
            dica="Faturamento, performance e validações de nota fiscal aparecem aqui assim que existirem."
          />
        ) : (
          <>
            <ul className="flex flex-col gap-2" aria-live="polite">
              {items.map((a, i) => (
                // Sem id estável na atividade (não é uma entidade própria —
                // união read-only de 3 fontes, data-model.md) — chave
                // composta tipo+data+índice é estável o bastante para esta
                // lista somente-append.
                <LinhaAtividade key={`${a.tipo}-${a.data ?? 'sem-data'}-${i}`} atividade={a} />
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Mostrando {items.length} de {total} {total === 1 ? 'atividade' : 'atividades'}.
            </p>
          </>
        )}

        {erro && (
          <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            {erro}
          </p>
        )}

        {!carregandoDetalhe && temMais && (
          <Button
            variant="outline"
            size="sm"
            className="w-fit min-h-11 sm:min-h-8"
            onClick={carregarMais}
            disabled={carregandoMais}
            aria-busy={carregandoMais}
          >
            {carregandoMais && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            Carregar mais
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
