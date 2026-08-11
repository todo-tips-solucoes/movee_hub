// hub-importacoes (S4) FASE 6 task 6.3.4 — fluxo completo de upload
// mockado: happy path + 409 (duplicado, link p/ original) + 422 (motivo).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportWizard } from './import-wizard';
import { ImportacaoApiError } from '@/lib/hub/importacoes-api';
import { COLUNAS_IMPORTACAO } from '@/lib/hub/importacoes-formato';

const mockEnviarImportacao = vi.fn();

vi.mock('@/lib/hub/importacoes-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/importacoes-api')>('@/lib/hub/importacoes-api');
  return {
    ...actual,
    enviarImportacao: (...args: unknown[]) => mockEnviarImportacao(...args),
  };
});

function abrirDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Nova importação' }));
}

function selecionarArquivo(file: File) {
  const input = screen.getByLabelText('Arquivo de importação') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file] });
  fireEvent.change(input);
}

describe('ImportWizard', () => {
  beforeEach(() => {
    mockEnviarImportacao.mockReset();
  });

  it('não renderiza nada sem permissão importacoes.criar', () => {
    render(<ImportWizard podeCriar={false} />);
    expect(screen.queryByRole('button', { name: 'Nova importação' })).not.toBeInTheDocument();
  });

  it('valida extensão client-side ANTES do POST (espelha 3.1.1) — não chama a API', () => {
    render(<ImportWizard />);
    abrirDialog();
    selecionarArquivo(new File(['conteudo'], 'arquivo.txt', { type: 'text/plain' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Extensão não suportada');
    expect(mockEnviarImportacao).not.toHaveBeenCalled();
    // Botão Enviar permanece desabilitado sem arquivo válido selecionado.
    expect(screen.getByRole('button', { name: /Enviar/ })).toBeDisabled();
  });

  it('valida tamanho client-side (espelha 3.1.3) — não chama a API', () => {
    render(<ImportWizard />);
    abrirDialog();
    const grande = new File(['x'], 'grande.csv', { type: 'text/csv' });
    Object.defineProperty(grande, 'size', { value: 20 * 1024 * 1024 + 1 });
    selecionarArquivo(grande);

    expect(screen.getByRole('alert')).toHaveTextContent('excede o tamanho máximo');
    expect(mockEnviarImportacao).not.toHaveBeenCalled();
  });

  it('happy path: seleciona tipo + arquivo válido, envia e notifica onEnviado', async () => {
    mockEnviarImportacao.mockResolvedValueOnce({ id: 42, status: 'pending' });
    const onEnviado = vi.fn();
    render(<ImportWizard onEnviado={onEnviado} />);
    abrirDialog();

    // impeccable rodada 2: o tipo virou radio-cards — seleciona pelo rótulo.
    fireEvent.click(screen.getByRole('radio', { name: /Performance/ }));
    selecionarArquivo(new File(['a,b\n1,2'], 'dados.csv', { type: 'text/csv' }));

    fireEvent.click(screen.getByRole('button', { name: /Enviar/ }));

    await waitFor(() => expect(mockEnviarImportacao).toHaveBeenCalledWith('performance', expect.any(File)));
    await waitFor(() => expect(onEnviado).toHaveBeenCalledWith(42));
  });

  it('409 CONFLITO: mostra mensagem + link para a importação original', async () => {
    mockEnviarImportacao.mockRejectedValueOnce(
      new ImportacaoApiError(409, 'Este arquivo já foi importado anteriormente.', 'CONFLITO', undefined, 77)
    );
    render(<ImportWizard />);
    abrirDialog();
    selecionarArquivo(new File(['a,b\n1,2'], 'dados.csv', { type: 'text/csv' }));
    fireEvent.click(screen.getByRole('button', { name: /Enviar/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('já foi importado'));
    expect(screen.getByRole('link', { name: 'Ver importação original' })).toHaveAttribute(
      'href',
      '/hub/dashboard/importacoes/77'
    );
  });

  it('422 INVALIDO: mostra o motivo legível vindo do backend', async () => {
    mockEnviarImportacao.mockRejectedValueOnce(
      new ImportacaoApiError(422, 'O arquivo não contém nenhuma linha legível.', 'INVALIDO', 'conteudo_vazio')
    );
    render(<ImportWizard />);
    abrirDialog();
    selecionarArquivo(new File(['a,b\n1,2'], 'dados.csv', { type: 'text/csv' }));
    fireEvent.click(screen.getByRole('button', { name: /Enviar/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('nenhuma linha legível'));
  });

  // impeccable rodada 13 (h10=2) — o formato do arquivo dito na tela.
  describe('o que o arquivo precisa ter', () => {
    it('lista as colunas do tipo escolhido NA ORDEM e diz que a ordem importa', () => {
      render(<ImportWizard />);
      abrirDialog();

      const itens = screen.getAllByRole('listitem').map((li) => li.textContent);
      expect(itens).toEqual([...COLUNAS_IMPORTACAO.faturamento]);
      // A ordem é a metade do requisito que o usuário não tem como adivinhar:
      // o backend reprova o cabeçalho inteiro e não grava nada.
      expect(screen.getByText(/nesta ordem exata/)).toBeInTheDocument();
    });

    it('troca a lista ao trocar o tipo (a de performance é outra)', () => {
      render(<ImportWizard />);
      abrirDialog();
      fireEvent.click(screen.getByRole('radio', { name: /Performance/i }));

      const itens = screen.getAllByRole('listitem').map((li) => li.textContent);
      expect(itens).toEqual([...COLUNAS_IMPORTACAO.performance]);
      expect(itens).not.toEqual([...COLUNAS_IMPORTACAO.faturamento]);
    });

    it('o modelo baixado tem o cabeçalho do tipo escolhido, com ; e quebra de linha', async () => {
      const blobs: Blob[] = [];
      const criar = vi.fn((b: Blob) => {
        blobs.push(b);
        return 'blob:modelo';
      });
      vi.stubGlobal('URL', { ...URL, createObjectURL: criar, revokeObjectURL: vi.fn() });

      render(<ImportWizard />);
      abrirDialog();
      fireEvent.click(screen.getByRole('button', { name: /Baixar modelo/ }));

      expect(criar).toHaveBeenCalledTimes(1);
      expect(await blobs[0].text()).toBe(`${COLUNAS_IMPORTACAO.faturamento.join(';')}\n`);
      vi.unstubAllGlobals();
    });
  });
});
