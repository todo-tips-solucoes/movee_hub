// uiux-hub F2 — StatusBadge compartilhado: garante o contrato WCAG 1.4.1
// (cor nunca é o único sinal: sempre há ícone + texto) e o fail-safe de
// status desconhecido.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AtivoBadge, ImportacaoStatusBadge, VinculoBadge } from './status-badge';
import type { StatusImportacao } from '@/lib/hub/importacoes-dto';

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
