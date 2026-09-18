// uiux-hub F2 — StatusBadge compartilhado: garante o contrato WCAG 1.4.1
// (cor nunca é o único sinal: sempre há ícone + texto) e o fail-safe de
// status desconhecido.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdiantamentoStatusBadge, AtivoBadge, AvisoStatusBadge, ContaStatusBadge, ImportacaoStatusBadge, LoteItemSituacaoBadge, LoteStatusBadge, TipoAtividadeBadge, VinculoBadge } from './status-badge';
import type { StatusImportacao } from '@/lib/hub/importacoes-dto';
import type { TipoAtividade } from '@/lib/hub/motoristas-dto';
import type { StatusAviso } from '@/lib/hub/avisos-dto';

function iconeDentroDoBadge(container: HTMLElement): SVGElement | null {
  return container.querySelector('svg[aria-hidden="true"]');
}

describe('ImportacaoStatusBadge', () => {
  const casos: Array<[StatusImportacao, string]> = [
    ['completed', 'Concluída'],
    ['completed_with_errors', 'Concluída com erros'],
    ['failed', 'Falhou'],
    ['cancelled', 'Cancelada'],
    ['pending', 'Pendente'],
    ['validating', 'Validando'],
    ['processing', 'Processando'],
  ];

  it.each(casos)('status %s: renderiza rótulo + ícone decorativo (nunca só cor)', (status, rotulo) => {
    const { container } = render(<ImportacaoStatusBadge status={status} />);
    expect(screen.getByText(rotulo)).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });

  it('fail-safe: status desconhecido não lança e mostra o próprio código', () => {
    const { container } = render(
      <ImportacaoStatusBadge status={'status-novo-2027' as StatusImportacao} />
    );
    expect(screen.getByText('status-novo-2027')).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });
});

describe('AvisoStatusBadge', () => {
  const casos: Array<[StatusAviso, string]> = [
    ['na_fila', 'Na fila'],
    ['em_andamento', 'Em andamento'],
    ['concluido', 'Concluído'],
  ];

  it.each(casos)('status %s: renderiza rótulo + ícone decorativo (nunca só cor)', (status, rotulo) => {
    const { container } = render(<AvisoStatusBadge status={status} />);
    expect(screen.getByText(rotulo)).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });

  it('fail-safe: status desconhecido não lança e mostra o próprio código', () => {
    const { container } = render(<AvisoStatusBadge status={'status-novo-2027' as StatusAviso} />);
    expect(screen.getByText('status-novo-2027')).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });
});

describe('AtivoBadge / VinculoBadge', () => {
  it('AtivoBadge distingue Ativo/Inativo com texto + ícone', () => {
    const a = render(<AtivoBadge ativo />);
    expect(screen.getByText('Ativo')).toBeInTheDocument();
    expect(iconeDentroDoBadge(a.container)).not.toBeNull();

    const b = render(<AtivoBadge ativo={false} />);
    expect(screen.getByText('Inativo')).toBeInTheDocument();
    expect(iconeDentroDoBadge(b.container)).not.toBeNull();
  });

  it('VinculoBadge distingue Vinculado/Sem vínculo com texto + ícone', () => {
    const a = render(<VinculoBadge vinculado />);
    expect(screen.getByText('Vinculado')).toBeInTheDocument();
    expect(iconeDentroDoBadge(a.container)).not.toBeNull();

    const b = render(<VinculoBadge vinculado={false} />);
    expect(screen.getByText('Sem vínculo')).toBeInTheDocument();
    expect(iconeDentroDoBadge(b.container)).not.toBeNull();
  });
});

// FASE 6 (tasks.md 6.4/6.5) — tipo da atividade (faturamento/performance/
// validação de NF) no histórico do detalhe do motorista.
describe('TipoAtividadeBadge', () => {
  const casos: Array<[TipoAtividade, string]> = [
    ['faturamento', 'Faturamento'],
    ['performance', 'Performance'],
    ['validacao_nf', 'Validação de NF'],
  ];

  it.each(casos)('tipo %s: renderiza rótulo + ícone decorativo (nunca só cor)', (tipo, rotulo) => {
    const { container } = render(<TipoAtividadeBadge tipo={tipo} />);
    expect(screen.getByText(rotulo)).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });

  it('fail-safe: tipo desconhecido não lança e mostra o próprio código', () => {
    const { container } = render(<TipoAtividadeBadge tipo={'tipo-novo-2027' as TipoAtividade} />);
    expect(screen.getByText('tipo-novo-2027')).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });
});

// adiantamento-motorista (FASE 7, tasks.md 7.3.1/7.3.2) — mesmos rótulos de
// backend/lib/adiantamento-dto.js#ETAPA_ADIANTAMENTO (linhas 178-190).
describe('AdiantamentoStatusBadge', () => {
  const casos: Array<[string, string]> = [
    ['AGUARDANDO_CORTE', 'Solicitação recebida'],
    ['AGUARDANDO_PRODUCAO', 'Aguardando produção'],
    ['LIBERADA', 'Adiantamento liberado'],
    ['EM_LOTE', 'Incluído para pagamento'],
    ['EXPORTADA', 'Pagamento em processamento'],
    ['PAGA', 'Pagamento realizado'],
    ['FALHOU', 'Falha no pagamento'],
    ['INELEGIVEL', 'Inelegível'],
    ['REJEITADA', 'Rejeitado'],
    ['CANCELADA', 'Cancelado'],
    ['ENCERRADA', 'Pagamento não realizado'],
  ];

  it.each(casos)('status %s: renderiza rótulo + ícone decorativo (nunca só cor)', (status, rotulo) => {
    const { container } = render(<AdiantamentoStatusBadge status={status} />);
    expect(screen.getByText(rotulo)).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });

  it('fail-safe: status desconhecido não lança e mostra o próprio código', () => {
    const { container } = render(<AdiantamentoStatusBadge status="STATUS_NOVO_2027" />);
    expect(screen.getByText('STATUS_NOVO_2027')).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });
});

describe('ContaStatusBadge', () => {
  const casos: Array<[string, string]> = [
    ['PENDENTE', 'Pendente'],
    ['APROVADA', 'Aprovada'],
    ['REJEITADA', 'Rejeitada'],
    ['SUBSTITUIDA', 'Substituída'],
    ['CANCELADA', 'Cancelada'],
  ];

  it.each(casos)('status %s: renderiza rótulo + ícone decorativo (nunca só cor)', (status, rotulo) => {
    const { container } = render(<ContaStatusBadge status={status} />);
    expect(screen.getByText(rotulo)).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });

  it('fail-safe: status desconhecido não lança e mostra o próprio código', () => {
    const { container } = render(<ContaStatusBadge status="STATUS_NOVO_2027" />);
    expect(screen.getByText('STATUS_NOVO_2027')).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });
});

describe('LoteStatusBadge', () => {
  const casos: Array<[string, string]> = [
    ['GERANDO', 'Gerando'],
    ['GERADO', 'Gerado'],
    ['EXPORTADO', 'Exportado'],
    ['CONCLUIDO', 'Concluído'],
    ['CONCLUIDO_COM_FALHAS', 'Concluído com falhas'],
    ['CANCELADO', 'Cancelado'],
  ];

  it.each(casos)('status %s: renderiza rótulo + ícone decorativo (nunca só cor)', (status, rotulo) => {
    const { container } = render(<LoteStatusBadge status={status} />);
    expect(screen.getByText(rotulo)).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });

  it('fail-safe: status desconhecido não lança e mostra o próprio código', () => {
    const { container } = render(<LoteStatusBadge status="STATUS_NOVO_2027" />);
    expect(screen.getByText('STATUS_NOVO_2027')).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });
});

describe('LoteItemSituacaoBadge', () => {
  const casos: Array<[string, string]> = [
    ['incluido', 'Incluído'],
    ['pago', 'Pago'],
    ['falhou', 'Falhou'],
    ['cancelado', 'Cancelado'],
  ];

  it.each(casos)('situação %s: renderiza rótulo + ícone decorativo (nunca só cor)', (situacao, rotulo) => {
    const { container } = render(<LoteItemSituacaoBadge situacao={situacao} />);
    expect(screen.getByText(rotulo)).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });

  it('fail-safe: situação desconhecida não lança e mostra o próprio código', () => {
    const { container } = render(<LoteItemSituacaoBadge situacao="situacao_nova_2027" />);
    expect(screen.getByText('situacao_nova_2027')).toBeInTheDocument();
    expect(iconeDentroDoBadge(container)).not.toBeNull();
  });
});
