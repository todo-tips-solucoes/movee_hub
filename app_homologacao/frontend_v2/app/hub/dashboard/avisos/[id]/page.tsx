'use client';

// hub-avisos (push-motorista, FASE 7 — tasks.md 7.4) — rota
// `/hub/dashboard/avisos/[id]`: detalhe do aviso com polling de 4s até
// `status = concluido`. Molde de `hooks/use-importacao-polling.ts:36-99`
// (interval + cleanup + guarda contra requisição sobreposta/pós-unmount +
// tolerância a falhas transitórias), reimplementado aqui (não extraído para
// `hooks/` — o único consumidor é esta página).
//
// Ref: docs/specs/envioMassa_homologacao/contracts/hub-avisos.md
// §GET /avisos/:id, tasks.md 7.4, FR-022 (rótulo "aceitos" nunca
// "lidos"/"entregues").

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { AvisoStatusBadge } from '@/components/hub/status-badge';
import { LARGURA_DETALHE } from '@/lib/hub/larguras';
import { AvisoApiError, obterAviso } from '@/lib/hub/avisos-api';
import { MODO_DESTINATARIOS_LABELS, type AvisoDetalhe } from '@/lib/hub/avisos-dto';
import { formatDateBR } from '@/lib/utils';

const POLL_INTERVAL_MS = 4000;
// Mesma tolerância de `use-importacao-polling.ts` (F8.3): uma falha
// transitória de rede não deve derrubar o acompanhamento automático.
const MAX_FALHAS_CONSECUTIVAS = 3;

/** Lógica isolada do JSX (mesmo padrão de `useImportacaoPolling`). */
export function useAvisoPolling(id: number) {
  const [detalhe, setDetalhe] = useState<AvisoDetalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [atualizacaoPausada, setAtualizacaoPausada] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const falhasRef = useRef(0);
  const emVooRef = useRef(false);
  const montadoRef = useRef(true);

  const pararPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const buscar = useCallback(async () => {
    if (emVooRef.current) return null;
    emVooRef.current = true;
    try {
      const d = await obterAviso(id);
      if (!montadoRef.current) return null;
      falhasRef.current = 0;
      setDetalhe(d);
      setErro(null);
      setAtualizacaoPausada(false);
      // 7.4.1 — polling PARA exatamente ao atingir `concluido`.
      if (d.status === 'concluido') pararPolling();
      return d;
    } catch (e) {
      if (!montadoRef.current) return null;
      falhasRef.current += 1;
      setErro(e instanceof AvisoApiError ? e.message : 'Não foi possível consultar o status do aviso.');
      if (falhasRef.current >= MAX_FALHAS_CONSECUTIVAS) {
        setAtualizacaoPausada(true);
        pararPolling();
      }
      return null;
    } finally {
      emVooRef.current = false;
      if (montadoRef.current) setCarregando(false);
    }
  }, [id, pararPolling]);

  const iniciarPolling = useCallback(() => {
    pararPolling();
    falhasRef.current = 0;
    setAtualizacaoPausada(false);
    intervalRef.current = setInterval(() => {
      buscar();
    }, POLL_INTERVAL_MS);
  }, [buscar, pararPolling]);

  useEffect(() => {
    montadoRef.current = true;
    buscar().then((d) => {
      if (montadoRef.current && d && d.status !== 'concluido') iniciarPolling();
    });
    return () => {
      montadoRef.current = false;
      pararPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- iniciarPolling/pararPolling só mudam se id mudar
  }, [id]);

  return { detalhe, carregando, erro, atualizacaoPausada, refetch: buscar, iniciarPolling };
}

/** Resume o destino do aviso a partir do polimorfismo de
 * `AvisoDetalhe.destinatarios` (contracts/hub-avisos.md §GET /avisos/:id). */
function resumoDestinatarios(d: AvisoDetalhe): string {
  if (d.modoDestinatarios === 'empresa' && 'empresas' in d.destinatarios) {
    const nomes = d.destinatarios.empresas.map((e) => e.nome ?? `#${e.id}`).join(', ');
    return nomes ? `Empresa/filial: ${nomes}` : MODO_DESTINATARIOS_LABELS.empresa;
  }
  if (d.modoDestinatarios === 'individual' && 'qtdMotoristas' in d.destinatarios) {
    return `${d.destinatarios.qtdMotoristas} motorista(s) selecionado(s)`;
  }
  return MODO_DESTINATARIOS_LABELS[d.modoDestinatarios];
}

export default function AvisoDetalhePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);
  const { detalhe, carregando, erro, atualizacaoPausada, refetch, iniciarPolling } = useAvisoPolling(id);

  if (!Number.isFinite(id)) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <p role="alert" className="text-sm font-medium text-destructive">
          Identificador de aviso inválido.
        </p>
      </div>
    );
  }

  return (
    <div className={`mx-auto flex ${LARGURA_DETALHE} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <Button
        variant="ghost"
        size="sm"
        className="w-fit min-h-11 gap-1.5 sm:min-h-8"
        onClick={() => (window.history.length > 1 ? router.back() : router.push('/hub/dashboard/avisos'))}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Voltar aos avisos
      </Button>

      {carregando && !detalhe ? (
        <ListSkeleton label="Carregando aviso..." linhas={4} />
      ) : erro && !detalhe ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
        >
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{erro}</p>
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => refetch()}>
            <RotateCw className="size-4" aria-hidden="true" />
            Tentar novamente
          </Button>
        </div>
      ) : detalhe ? (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle as="h1" className="text-lg">
              {detalhe.titulo}
            </CardTitle>
            <AvisoStatusBadge status={detalhe.status} />
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-4">
            <p className="text-sm text-muted-foreground">{detalhe.corpo}</p>

            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Destinatários</p>
                <p>{resumoDestinatarios(detalhe)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Criado em</p>
                <p>{formatDateBR(detalhe.criadoEm) || '-'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Concluído em</p>
                <p>{formatDateBR(detalhe.concluidoEm) || '-'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Visados</p>
                <p className="font-mono">{detalhe.contagens.visados}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Pendentes</p>
                <p className="font-mono">{detalhe.contagens.pendentes}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Processando</p>
                <p className="font-mono">{detalhe.contagens.processando}</p>
              </div>
              {/* FR-022 — rótulo integral, nunca "lidos"/"entregues". */}
              <div>
                <p className="text-xs text-muted-foreground">Aceitos pelo serviço de push</p>
                <p className="font-mono">{detalhe.contagens.aceitos}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Falhas</p>
                <p className="font-mono">{detalhe.contagens.falhas}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Inscrições mortas</p>
                <p className="font-mono">{detalhe.contagens.mortas}</p>
              </div>
            </div>

            {atualizacaoPausada && detalhe.status !== 'concluido' && (
              <p
                role="status"
                className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm font-medium text-warning-strong"
              >
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                Atualização automática pausada — não foi possível consultar o status mais recente.
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-auto min-h-0 p-0 underline"
                  onClick={async () => {
                    const d = await refetch();
                    if (d && d.status !== 'concluido') iniciarPolling();
                  }}
                >
                  Tentar novamente
                </Button>
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
