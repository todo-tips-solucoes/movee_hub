'use client';

// F4b (nota-pendente-motorista) — lista das notas que o motorista enviou
// DEPOIS do fechamento do movimento. Existe porque o pagamento retido é
// liberado por UMA PESSOA: não há gate automático entre nota e pagamento.
// Sem esta lista, o motorista regulariza e ninguém é avisado.
//
// Só aparece quando há itens: sem nenhuma regularização não há o que o
// operador fazer, e um "nenhuma regularização" fixo viraria ruído permanente.

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatBRL, formatDateBR } from '@/lib/utils';
import {
  ValidacaoXmlApiError,
  listarRegularizadas,
  type RegularizadasResponse,
} from '@/lib/hub/validacao-xml-api';

function formatarQuando(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function NotasRegularizadasSection() {
  const [dados, setDados] = useState<RegularizadasResponse | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setDados(await listarRegularizadas());
    } catch (e) {
      setErro(e instanceof ValidacaoXmlApiError ? e.message : 'Não foi possível carregar as notas enviadas após o fechamento.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (carregando) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Carregando notas enviadas após o fechamento...
      </p>
    );
  }

  if (erro) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
        <p className="text-sm font-medium text-destructive">{erro}</p>
        <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void carregar()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (!dados || dados.itens.length === 0) return null;

  return (
    <section aria-labelledby="notas-regularizadas-titulo" className="space-y-3">
      <div>
        <h2 id="notas-regularizadas-titulo" className="font-heading text-lg font-semibold text-foreground">
          Pagamentos retidos aguardando liberação
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Estes motoristas enviaram a nota depois que o movimento foi fechado. O pagamento deles segue retido até
          você liberá-lo manualmente: o sistema não libera sozinho.
        </p>
        {dados.total > dados.limite && (
          <p className="mt-1 text-sm text-muted-foreground">
            Mostrando as {dados.itens.length} mais recentes de {dados.total} no total.
          </p>
        )}
      </div>
      <ul className="divide-y rounded-lg border">
        {dados.itens.map((n) => (
          <li key={n.id} className="grid gap-1 p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{n.nome || '—'}</p>
              <p className="text-xs text-muted-foreground">
                CNPJ {n.cnpjPrestador || '—'} · Movimento de {formatDateBR(n.dtInicial) || '—'} a{' '}
                {formatDateBR(n.dtFinal) || '—'}
              </p>
              <p className="text-xs text-muted-foreground">Regularizada em {formatarQuando(n.regularizadaEm)}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-medium tabular-nums text-foreground">{formatBRL(n.valor)}</span>
              <Badge variant={n.notaAprovada ? 'success' : 'destructive'}>
                {n.notaAprovada ? 'Nota aprovada' : 'Nota recusada'}
              </Badge>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
