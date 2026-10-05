// O upload do envio em massa é tudo-ou-nada: uma linha ruim derruba a planilha
// inteira. O backend sempre soube QUAIS linhas recusou (`errors[]` com
// `rowIndex` e motivo), mas o cliente jogava isso fora em `new Error(message)` e
// a tela só dizia "Erros de validação encontrados. Nenhum registro foi inserido".
//
// Caso real (05/10): 982 linhas, 4 recusadas — alguém escreveu "Em andamento" /
// "Não localizado" na coluna do CNPJ. Achar isso exigiu abrir o XLSX e rodar as
// validações do servidor à mão.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportButton } from './import-button';
import { ApiError } from '@/lib/api-client';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ARQUIVO = new File(['x'], 'planilha.xlsx', {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

/** Erro como o backend devolve: 4 linhas, duas delas com o mesmo motivo. */
function erroDe4Linhas() {
  return new ApiError('Erros de validação encontrados. Nenhum registro foi inserido.', 400, [
    { linha: 329, motivos: ['cnpj_prestador inválido (deve conter 14 dígitos).'] },
    { linha: 361, motivos: ['cnpj_prestador inválido (deve conter 14 dígitos).'] },
    { linha: 413, motivos: ['cnpj_prestador inválido (deve conter 14 dígitos).'] },
    { linha: 542, motivos: ['cnpj_prestador inválido (deve conter 14 dígitos).', 'nome é obrigatório.'] },
  ]);
}

async function enviar(onUpload: (f: File, e?: Record<string, string>) => Promise<unknown>) {
  render(<ImportButton onUpload={onUpload} />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [ARQUIVO] });
  fireEvent.change(input);
  fireEvent.change(screen.getByLabelText('Data inicial'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('Data final'), { target: { value: '2026-10-05' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
}

describe('ImportButton — linhas recusadas', () => {
  it('mostra quantas linhas falharam e em quais linhas do Excel', async () => {
    await enviar(vi.fn().mockRejectedValue(erroDe4Linhas()));

    expect(await screen.findByText('4 linhas precisam de correção')).toBeInTheDocument();
    // agrupado por motivo, com as linhas — é isso que diz o que fazer
    expect(screen.getByText(/4× cnpj_prestador inválido/)).toBeInTheDocument();
    expect(screen.getByText(/329, 361, 413, 542/)).toBeInTheDocument();
    // a segunda razão da linha 542 não pode sumir
    expect(screen.getByText(/1× nome é obrigatório/)).toBeInTheDocument();
  });

  it('o motivo mais frequente vem primeiro — é ele que diz o que fazer', async () => {
    // Com 982 linhas, a ordem é o que separa "corrija a coluna do CNPJ" de uma
    // lista para ler inteira. O comentário do código afirma isso; sem este
    // teste, uma "limpeza" na ordenação passaria despercebida.
    await enviar(vi.fn().mockRejectedValue(erroDe4Linhas()));
    await screen.findByText('4 linhas precisam de correção');
    const motivos = screen.getAllByText(/^\d+× /).map((el) => el.textContent ?? '');
    expect(motivos[0]).toMatch(/^4× cnpj_prestador/);
    expect(motivos[1]).toMatch(/^1× nome/);
  });

  it('diz que nada foi inserido — o usuário precisa saber que é tudo ou nada', async () => {
    await enviar(vi.fn().mockRejectedValue(erroDe4Linhas()));
    expect(await screen.findByText(/Nenhum registro foi inserido/)).toBeInTheDocument();
  });

  it('não expõe o conteúdo da linha, só onde e o quê', async () => {
    // o backend manda `preview` com a linha inteira (nome, telefone, CNPJ); o
    // cliente não carrega isso adiante de propósito
    const erro = new ApiError('x', 400, [{ linha: 7, motivos: ['nome é obrigatório.'] }]);
    (erro as unknown as { linhasInvalidas: unknown[] }).linhasInvalidas = [
      { linha: 7, motivos: ['nome é obrigatório.'] },
    ];
    await enviar(vi.fn().mockRejectedValue(erro));
    await screen.findByText('1 linha precisa de correção');
    expect(document.body.textContent).not.toMatch(/\(11\)|@|\d{14}/);
  });

  it('erro sem detalhe de linha cai no aviso simples, sem abrir a lista', async () => {
    await enviar(vi.fn().mockRejectedValue(new Error('Falha de rede')));
    await waitFor(() => expect(screen.queryByText(/precisam de correção/)).not.toBeInTheDocument());
    expect(screen.queryByText(/precisa de correção/)).not.toBeInTheDocument();
  });

  it('upload bem-sucedido não mostra lista de erro nenhuma', async () => {
    await enviar(vi.fn().mockResolvedValue({ success: true }));
    await waitFor(() => expect(screen.queryByText(/correção/)).not.toBeInTheDocument());
  });
});
