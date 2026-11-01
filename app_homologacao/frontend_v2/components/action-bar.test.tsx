// Botões do envio em massa escondidos por permissão. O painel legado monta esta
// mesma barra sem passar nada: o default `true` não pode mudar o que ele vê.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionBar } from './action-bar';

vi.mock('./process-controls', () => ({ ProcessControls: () => <div data-testid="process-controls" /> }));
vi.mock('./import-button', () => ({ ImportButton: () => <div data-testid="import-button" /> }));
vi.mock('./close-movement-dialog', () => ({ CloseMovementDialog: () => <div data-testid="close-movement" /> }));
vi.mock('@/components/hub/gerar-do-repasse-button', () => ({ GerarDoRepasseButton: () => null }));

function renderBarra(props: Partial<React.ComponentProps<typeof ActionBar>> = {}) {
  return render(
    <ActionBar
      isActive={false}
      isProcessLoading={false}
      onStart={vi.fn()}
      onStop={vi.fn()}
      onUpload={vi.fn()}
      onExportCSV={vi.fn()}
      onDownloadXML={vi.fn()}
      onCloseMovement={vi.fn()}
      {...props}
    />
  );
}

describe('ActionBar — permissões', () => {
  it('sem props (painel legado) mostra Disparar, Importar e Fechar movimento', () => {
    renderBarra();
    expect(screen.getByTestId('process-controls')).toBeInTheDocument();
    expect(screen.getByTestId('import-button')).toBeInTheDocument();
    expect(screen.getByTestId('close-movement')).toBeInTheDocument();
  });

  it('cada permissão false esconde só o seu botão', () => {
    const a = renderBarra({ podeAprovar: false });
    expect(screen.queryByTestId('close-movement')).toBeNull();
    expect(screen.getByTestId('import-button')).toBeInTheDocument();
    expect(screen.getByTestId('process-controls')).toBeInTheDocument();
    a.unmount();

    const b = renderBarra({ podeCriar: false });
    expect(screen.queryByTestId('import-button')).toBeNull();
    expect(screen.getByTestId('close-movement')).toBeInTheDocument();
    b.unmount();

    renderBarra({ podeEnviar: false });
    expect(screen.queryByTestId('process-controls')).toBeNull();
    expect(screen.getByTestId('close-movement')).toBeInTheDocument();
  });

  it('financeiro sem aprovar ainda exporta CSV e baixa XML (consultar)', () => {
    renderBarra({ podeAprovar: false, podeCriar: false, podeEnviar: false });
    expect(screen.getByRole('button', { name: /Exportar CSV/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download XML/ })).toBeInTheDocument();
  });
});
