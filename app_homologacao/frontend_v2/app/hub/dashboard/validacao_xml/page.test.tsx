// hub-uiux-refresh (2026-08-05) — teste unitário do módulo Validação XML:
// (1) renderiza o XmlValidationCard com entidade ativa; (2) guard redireciona
// para /selecionar-entidade quando não há entidade ativa (mesmo contrato da
// tela de envio_massa de onde o card migrou — migration 0045).
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ValidacaoXmlHubPage, { SELECIONAR_ENTIDADE_ROUTE } from './page';

const mockReplace = vi.fn();
let mockAuth: { entidadeAtiva: number | null; carregando: boolean };

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockAuth,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock('@/components/xml-validation-card', () => ({
  XmlValidationCard: () => <div data-testid="xml-validation-card" />,
}));

describe('ValidacaoXmlHubPage', () => {
  beforeEach(() => {
    mockReplace.mockClear();
  });

  it('com entidade ativa: renderiza título e o XmlValidationCard, sem redirect', () => {
    mockAuth = { entidadeAtiva: 9001, carregando: false };
    render(<ValidacaoXmlHubPage />);
    expect(screen.getByRole('heading', { name: 'Validação XML' })).toBeInTheDocument();
    expect(screen.getByTestId('xml-validation-card')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('sem entidade ativa: redireciona para /selecionar-entidade (guard FR-004)', () => {
    mockAuth = { entidadeAtiva: null, carregando: false };
    render(<ValidacaoXmlHubPage />);
    expect(mockReplace).toHaveBeenCalledWith(SELECIONAR_ENTIDADE_ROUTE);
  });
});
