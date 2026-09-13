'use client';

/**
 * push-motorista (tasks.md 6.2) — passo de contexto e os 5 estados de
 * ativação de notificações (FR-001 a FR-007, US1).
 *
 * O pedido de permissão do navegador só dispara dentro do handler de clique
 * de "Ativar notificações" (FR-002) — nunca em efeito de montagem. Fixado
 * no card de contexto de `app/(app)/movimento/page.tsx` (6.2.3, CHK003).
 *
 * Ref: contracts/motorista-push.md, spec FR-001 a FR-007, US1 Acceptance
 * Scenarios 1-8, 11.
 */

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ativar, estadoAtual, reportarEstado, type EstadoPush } from '@/lib/push';
import { Button } from '@/components/ui/button';
import { Bell, BellOff, BellRing, Info, Smartphone } from '@/components/ui/icons';

const LS_DISPENSADO = 'notificacoes.contexto.dispensado';

export function NotificacoesCard() {
  const [estado, setEstado] = useState<EstadoPush | null>(null);
  const [dispensado, setDispensado] = useState(true);
  const [ativando, setAtivando] = useState(false);
  const ultimoReportado = useRef<EstadoPush | null>(null);

  // Client-only: lê Notification.permission/suporte só após montar (evita
  // divergência de SSR) e nunca dispara pedido de permissão sozinho (FR-002).
  useEffect(() => {
    setEstado(estadoAtual());
    setDispensado(window.localStorage.getItem(LS_DISPENSADO) === '1');
  }, []);

  // FR-007/Acceptance Scenario 11 — reporta ao servidor sempre que o estado
  // exibido muda (inclusive os 4 estados que lib/push.ts não reporta sozinho).
  useEffect(() => {
    if (!estado || ultimoReportado.current === estado) return;
    ultimoReportado.current = estado;
    reportarEstado(estado);
  }, [estado]);

  if (estado === null) return null;

  async function handleAtivar() {
    setAtivando(true);
    try {
      const resultado = await ativar();
      ultimoReportado.current = null; // força reportarEstado do novo estado
      setEstado(resultado.estado);
      if (resultado.ok) {
        toast.success('Notificações ativadas.');
      } else if (resultado.estado === 'bloqueadas') {
        toast.error('Permissão negada. Reative nas configurações do navegador.');
      } else if (resultado.erro) {
        toast.error(resultado.erro);
      }
    } finally {
      setAtivando(false);
    }
  }

  function handleDispensar() {
    window.localStorage.setItem(LS_DISPENSADO, '1');
    setDispensado(true);
  }

  if (estado === 'ativas') {
    return (
      <div className="animate-fade-up mb-4 flex items-center gap-3 rounded-2xl border border-success/30 bg-success/10 px-4 py-3">
        <BellRing className="h-5 w-5 shrink-0 text-success" />
        <p className="text-sm font-medium text-success">Notificações ativas neste aparelho.</p>
      </div>
    );
  }

  if (estado === 'bloqueadas') {
    return (
      <div className="animate-fade-up mb-4 rounded-2xl border border-warm-2/30 bg-warm-2/10 p-4">
        <p className="font-display flex items-center gap-2 text-sm font-semibold text-warm-3">
          <BellOff className="h-4 w-4" aria-hidden="true" />
          Notificações bloqueadas
        </p>
        <p className="mt-1 text-xs text-warm-3/90">
          Você negou a permissão. Para reativar, ajuste as notificações deste site nas
          configurações do navegador ou do aparelho.
        </p>
      </div>
    );
  }

  if (estado === 'ios_sem_instalacao') {
    return (
      <div className="animate-fade-up mb-4 rounded-2xl border border-border bg-muted/40 p-4">
        <p className="font-display flex items-center gap-2 text-sm font-semibold">
          <Smartphone className="h-4 w-4" aria-hidden="true" />
          Instale o app para receber avisos
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Toque em Compartilhar e depois em &ldquo;Adicionar à Tela de Início&rdquo;. Sem
          isso, o iPhone não entrega notificações deste app.
        </p>
      </div>
    );
  }

  if (estado === 'sem_suporte') {
    return (
      <div className="animate-fade-up mb-4 rounded-2xl border border-border bg-muted/40 p-4 text-xs text-muted-foreground">
        Este navegador não recebe notificações. Você continua vendo tudo por aqui,
        normalmente.
      </div>
    );
  }

  // nao_ativadas: passo de contexto completo, ou ponto de entrada compacto
  // se já foi dispensado uma vez (FR-007, Acceptance Scenario 7).
  if (dispensado) {
    return (
      <button
        type="button"
        onClick={handleAtivar}
        disabled={ativando}
        className="animate-fade-up mb-4 flex w-full items-center gap-2 rounded-2xl border border-dashed border-border px-4 py-2.5 text-left text-sm font-medium text-muted-foreground transition hover:bg-muted/60 disabled:opacity-60"
      >
        <Bell className="h-4 w-4 shrink-0" aria-hidden="true" />
        {ativando ? 'Ativando…' : 'Ativar notificações de avisos'}
      </button>
    );
  }

  return (
    <div className="animate-fade-up mb-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="font-display flex items-center gap-2 text-sm font-semibold">
        <Info className="h-4 w-4 text-primary" aria-hidden="true" />
        Receba avisos importantes
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Ative as notificações para saber na hora quando a equipe enviar um aviso — sem
        precisar ficar abrindo o app.
      </p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={handleAtivar} disabled={ativando} className="flex-1">
          {ativando ? 'Ativando…' : 'Ativar notificações'}
        </Button>
        <Button size="sm" variant="ghost" onClick={handleDispensar} disabled={ativando}>
          Agora não
        </Button>
      </div>
    </div>
  );
}
