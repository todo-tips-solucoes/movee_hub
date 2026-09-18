// uiux-hub F2 (P1 — WCAG 1.4.1) — badge de status compartilhado: SEMPRE
// cor + ícone + texto, nunca só cor. Centraliza os mapas que antes viviam
// duplicados em importacoes/page.tsx (StatusBadge local) e
// motoristas/page.tsx (AtivoBadge/VinculoBadge).

import {
  AlertTriangle,
  Ban,
  Banknote,
  CheckCircle2,
  CircleOff,
  Clock,
  FileCheck2,
  Gauge,
  Layers,
  Link2,
  Link2Off,
  RotateCw,
  Send,
  ShieldOff,
  Wallet,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Badge, type badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';
import { STATUS_LABELS, type StatusImportacao } from '@/lib/hub/importacoes-dto';
import type { TipoAtividade } from '@/lib/hub/motoristas-dto';
import { STATUS_AVISO_LABELS, type StatusAviso } from '@/lib/hub/avisos-dto';
import { cn } from '@/lib/utils';

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

interface StatusBadgeProps {
  variant: BadgeVariant;
  icon: LucideIcon;
  /** Gira o ícone (estados "em processamento"); respeita reduced-motion. */
  spin?: boolean;
  children: React.ReactNode;
}

/** Base: Badge com ícone à esquerda. O ícone é decorativo (aria-hidden) —
 * o significado está no texto; o ícone reforça sem depender de cor. */
export function StatusBadge({ variant, icon: Icon, spin = false, children }: StatusBadgeProps) {
  return (
    <Badge variant={variant}>
      <Icon
        data-icon="inline-start"
        aria-hidden="true"
        className={cn('shrink-0', spin && 'motion-safe:animate-spin')}
      />
      {children}
    </Badge>
  );
}

const IMPORTACAO_STATUS_BADGE: Record<
  StatusImportacao,
  { variant: BadgeVariant; icon: LucideIcon; spin?: boolean }
> = {
  completed: { variant: 'success', icon: CheckCircle2 },
  completed_with_errors: { variant: 'warning', icon: AlertTriangle },
  failed: { variant: 'destructive', icon: XCircle },
  cancelled: { variant: 'secondary', icon: Ban },
  pending: { variant: 'outline', icon: Clock },
  validating: { variant: 'outline', icon: RotateCw, spin: true },
  processing: { variant: 'outline', icon: RotateCw, spin: true },
};

/** Status de importação (lista e detalhe). Fail-safe: status desconhecido
 * cai em outline+Clock com o próprio código como rótulo. */
export function ImportacaoStatusBadge({ status }: { status: StatusImportacao }) {
  const cfg = IMPORTACAO_STATUS_BADGE[status] ?? { variant: 'outline' as const, icon: Clock };
  return (
    <StatusBadge variant={cfg.variant} icon={cfg.icon} spin={cfg.spin}>
      {STATUS_LABELS[status] ?? status}
    </StatusBadge>
  );
}

/** Ativo/Inativo (motoristas, usuários). */
export function AtivoBadge({ ativo }: { ativo: boolean }) {
  return ativo ? (
    <StatusBadge variant="success" icon={CheckCircle2}>
      Ativo
    </StatusBadge>
  ) : (
    <StatusBadge variant="secondary" icon={CircleOff}>
      Inativo
    </StatusBadge>
  );
}

// FASE 6 (tasks.md 6.4/6.5) — tipo da atividade (seção "Atividades" do
// detalhe do motorista): faturamento/performance/validação de NF.
const ATIVIDADE_TIPO_BADGE: Record<TipoAtividade, { variant: BadgeVariant; icon: LucideIcon; label: string }> = {
  faturamento: { variant: 'default', icon: Wallet, label: 'Faturamento' },
  performance: { variant: 'outline', icon: Gauge, label: 'Performance' },
  validacao_nf: { variant: 'secondary', icon: FileCheck2, label: 'Validação de NF' },
};

/** Tipo de atividade (faturamento/performance/validação de NF). Fail-safe:
 * tipo desconhecido cai em outline+Clock com o próprio código como rótulo. */
export function TipoAtividadeBadge({ tipo }: { tipo: TipoAtividade }) {
  const cfg = ATIVIDADE_TIPO_BADGE[tipo] ?? { variant: 'outline' as const, icon: Clock, label: tipo };
  return (
    <StatusBadge variant={cfg.variant} icon={cfg.icon}>
      {cfg.label}
    </StatusBadge>
  );
}

// FASE 7 (push-motorista, tasks.md 7.2/7.4) — status do aviso (na fila/em
// andamento/concluído), lista e detalhe do módulo Avisos.
const AVISO_STATUS_BADGE: Record<StatusAviso, { variant: BadgeVariant; icon: LucideIcon; spin?: boolean }> = {
  na_fila: { variant: 'outline', icon: Clock },
  em_andamento: { variant: 'outline', icon: RotateCw, spin: true },
  concluido: { variant: 'success', icon: CheckCircle2 },
};

/** Status de aviso (lista e detalhe). Fail-safe: status desconhecido cai em
 * outline+Clock com o próprio código como rótulo. */
export function AvisoStatusBadge({ status }: { status: StatusAviso }) {
  const cfg = AVISO_STATUS_BADGE[status] ?? { variant: 'outline' as const, icon: Clock };
  return (
    <StatusBadge variant={cfg.variant} icon={cfg.icon} spin={cfg.spin}>
      {STATUS_AVISO_LABELS[status] ?? status}
    </StatusBadge>
  );
}

// adiantamento-motorista (FASE 7, tasks.md 7.3.1/7.3.2) — status de
// AdiantamentoSolicitacao. Rótulos IDÊNTICOS aos que
// `backend/lib/adiantamento-dto.js#ETAPA_ADIANTAMENTO` (linhas 178-190) usa
// para a timeline do app do motorista — mesmo enum, mesma tradução em
// português, para o financeiro (hub) e o motorista (app) nunca divergirem
// no nome do mesmo estado. O backend NÃO envia um `statusRotulo` pronto
// para o hub (SolicitacaoResumo só tem `status` cru) — a tradução é local,
// como os demais StatusBadge deste arquivo.
type StatusAdiantamento =
  | 'AGUARDANDO_CORTE' | 'AGUARDANDO_PRODUCAO' | 'LIBERADA' | 'EM_LOTE' | 'EXPORTADA'
  | 'PAGA' | 'FALHOU' | 'INELEGIVEL' | 'REJEITADA' | 'CANCELADA' | 'ENCERRADA';

const ADIANTAMENTO_STATUS_BADGE: Record<StatusAdiantamento, { variant: BadgeVariant; icon: LucideIcon; label: string; spin?: boolean }> = {
  AGUARDANDO_CORTE: { variant: 'outline', icon: Clock, label: 'Solicitação recebida' },
  AGUARDANDO_PRODUCAO: { variant: 'outline', icon: RotateCw, label: 'Aguardando produção', spin: true },
  LIBERADA: { variant: 'success', icon: CheckCircle2, label: 'Adiantamento liberado' },
  EM_LOTE: { variant: 'default', icon: Layers, label: 'Incluído para pagamento' },
  EXPORTADA: { variant: 'default', icon: Send, label: 'Pagamento em processamento' },
  PAGA: { variant: 'success', icon: Banknote, label: 'Pagamento realizado' },
  FALHOU: { variant: 'destructive', icon: XCircle, label: 'Falha no pagamento' },
  INELEGIVEL: { variant: 'secondary', icon: ShieldOff, label: 'Inelegível' },
  REJEITADA: { variant: 'destructive', icon: Ban, label: 'Rejeitado' },
  CANCELADA: { variant: 'secondary', icon: CircleOff, label: 'Cancelado' },
  ENCERRADA: { variant: 'secondary', icon: Ban, label: 'Pagamento não realizado' },
};

/** Status de solicitação de adiantamento (lista e detalhe do hub). Fail-safe:
 * status desconhecido cai em outline+Clock com o próprio código como rótulo
 * (mesmo padrão de `ImportacaoStatusBadge`/`AvisoStatusBadge`). */
export function AdiantamentoStatusBadge({ status }: { status: string }) {
  const cfg = ADIANTAMENTO_STATUS_BADGE[status as StatusAdiantamento] ?? { variant: 'outline' as const, icon: Clock, label: status };
  return (
    <StatusBadge variant={cfg.variant} icon={cfg.icon} spin={cfg.spin}>
      {cfg.label}
    </StatusBadge>
  );
}

/** Rótulo pt-BR de um status de adiantamento — reuso fora do badge (filtro
 * da lista, timeline de eventos do detalhe). Status desconhecido devolve o
 * próprio código, nunca lança. */
export function rotuloStatusAdiantamento(status: string): string {
  return ADIANTAMENTO_STATUS_BADGE[status as StatusAdiantamento]?.label ?? status;
}

/** Os 11 status reais (CHECK `adiantamentosolicitacao_status_chk`,
 * infra/hub/migrations/0066), na ordem do fluxo — insumo do filtro de
 * status da lista (`app/hub/dashboard/adiantamentos/page.tsx`). */
export const STATUS_ADIANTAMENTO_OPCOES: StatusAdiantamento[] = [
  'AGUARDANDO_CORTE', 'AGUARDANDO_PRODUCAO', 'LIBERADA', 'EM_LOTE', 'EXPORTADA',
  'PAGA', 'FALHOU', 'INELEGIVEL', 'REJEITADA', 'CANCELADA', 'ENCERRADA',
];

// adiantamento-motorista (FASE 7, tasks.md 7.5.1) — status de
// ContaBancariaMotorista (CHECK `contabancariamotorista_status_chk`,
// infra/hub/migrations/0066).
type StatusConta = 'PENDENTE' | 'APROVADA' | 'REJEITADA' | 'SUBSTITUIDA' | 'CANCELADA';

const CONTA_STATUS_BADGE: Record<StatusConta, { variant: BadgeVariant; icon: LucideIcon; label: string }> = {
  PENDENTE: { variant: 'outline', icon: Clock, label: 'Pendente' },
  APROVADA: { variant: 'success', icon: CheckCircle2, label: 'Aprovada' },
  REJEITADA: { variant: 'destructive', icon: Ban, label: 'Rejeitada' },
  SUBSTITUIDA: { variant: 'secondary', icon: CircleOff, label: 'Substituída' },
  CANCELADA: { variant: 'secondary', icon: CircleOff, label: 'Cancelada' },
};

/** Status de conta bancária (lista e revisão do hub). Fail-safe: status
 * desconhecido cai em outline+Clock com o próprio código como rótulo. */
export function ContaStatusBadge({ status }: { status: string }) {
  const cfg = CONTA_STATUS_BADGE[status as StatusConta] ?? { variant: 'outline' as const, icon: Clock, label: status };
  return (
    <StatusBadge variant={cfg.variant} icon={cfg.icon}>
      {cfg.label}
    </StatusBadge>
  );
}

/** Os 5 status reais, na ordem do fluxo — insumo do filtro de status da
 * lista (`app/hub/dashboard/adiantamentos/contas/page.tsx`). */
export const STATUS_CONTA_OPCOES: StatusConta[] = ['PENDENTE', 'APROVADA', 'REJEITADA', 'SUBSTITUIDA', 'CANCELADA'];

// adiantamento-motorista (FASE 7, tasks.md 7.7.1) — status de
// AdiantamentoLote (CHECK `adiantamentolote_status_chk`, infra/hub/migrations
// /0066:223; transições em data-model.md §State Transitions).
type StatusLote = 'GERANDO' | 'GERADO' | 'EXPORTADO' | 'CONCLUIDO' | 'CONCLUIDO_COM_FALHAS' | 'CANCELADO';

const LOTE_STATUS_BADGE: Record<StatusLote, { variant: BadgeVariant; icon: LucideIcon; label: string; spin?: boolean }> = {
  GERANDO: { variant: 'outline', icon: RotateCw, label: 'Gerando', spin: true },
  GERADO: { variant: 'default', icon: FileCheck2, label: 'Gerado' },
  EXPORTADO: { variant: 'default', icon: Send, label: 'Exportado' },
  CONCLUIDO: { variant: 'success', icon: CheckCircle2, label: 'Concluído' },
  CONCLUIDO_COM_FALHAS: { variant: 'warning', icon: AlertTriangle, label: 'Concluído com falhas' },
  CANCELADO: { variant: 'secondary', icon: CircleOff, label: 'Cancelado' },
};

/** Status de lote de pagamento (histórico e detalhe do hub). Fail-safe:
 * status desconhecido cai em outline+Clock com o próprio código como rótulo. */
export function LoteStatusBadge({ status }: { status: string }) {
  const cfg = LOTE_STATUS_BADGE[status as StatusLote] ?? { variant: 'outline' as const, icon: Clock, label: status };
  return (
    <StatusBadge variant={cfg.variant} icon={cfg.icon} spin={cfg.spin}>
      {cfg.label}
    </StatusBadge>
  );
}

/** Os 6 status reais, na ordem do fluxo — insumo do filtro de status de
 * `app/hub/dashboard/adiantamentos/lotes/page.tsx`. */
export const STATUS_LOTE_OPCOES: StatusLote[] = [
  'GERANDO', 'GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS', 'CANCELADO',
];

// adiantamento-motorista (FASE 7, tasks.md 7.7.2) — situação de
// AdiantamentoLoteItem (CHECK `adiantamentoloteitem_situacao_chk`,
// infra/hub/migrations/0066; data-model.md linha ~277). Minúsculo de
// propósito — é o valor literal que o backend grava, sem tradução de case.
type SituacaoLoteItem = 'incluido' | 'pago' | 'falhou' | 'cancelado';

const LOTE_ITEM_SITUACAO_BADGE: Record<SituacaoLoteItem, { variant: BadgeVariant; icon: LucideIcon; label: string }> = {
  incluido: { variant: 'outline', icon: Clock, label: 'Incluído' },
  pago: { variant: 'success', icon: CheckCircle2, label: 'Pago' },
  falhou: { variant: 'destructive', icon: XCircle, label: 'Falhou' },
  cancelado: { variant: 'secondary', icon: CircleOff, label: 'Cancelado' },
};

/** Situação de um item dentro de um lote (`lotes/[id]/page.tsx`). Fail-safe:
 * situação desconhecida cai em outline+Clock com o próprio código como rótulo. */
export function LoteItemSituacaoBadge({ situacao }: { situacao: string }) {
  const cfg = LOTE_ITEM_SITUACAO_BADGE[situacao as SituacaoLoteItem] ?? { variant: 'outline' as const, icon: Clock, label: situacao };
  return (
    <StatusBadge variant={cfg.variant} icon={cfg.icon}>
      {cfg.label}
    </StatusBadge>
  );
}

/** Vinculado/Sem vínculo (motoristas ↔ conta de acesso). */
export function VinculoBadge({ vinculado }: { vinculado: boolean }) {
  return vinculado ? (
    <StatusBadge variant="default" icon={Link2}>
      Vinculado
    </StatusBadge>
  ) : (
    <StatusBadge variant="outline" icon={Link2Off}>
      Sem vínculo
    </StatusBadge>
  );
}
