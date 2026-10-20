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

describe('ImportButton — reimportação (corrigir-movimento)', () => {
  const resumo = {
    total_linhas: 10, criados: 2, atualizados: 3, inalterados: 1, pulados_nota_enviada: 2,
    pulados_mov_fechado: 0, ambiguos: 1, sem_identificador: 1, mensagem_valor_antigo: 1, mensagem_divergente: 0,
  };

  it('mostra pulados e ambíguos no resumo em vez de só "sucesso"', async () => {
    const onUpload = vi.fn().mockResolvedValue({
      success: true, resumo,
      pulados: [{ linha: 4, id: 55, motivo: 'nota_enviada' }, { linha: 9, id: 56, motivo: 'nota_enviada' }],
      ambiguos: [{ linha: 6, cnpj_prestador: '12345678000199', candidatos: [70, 71] }],
    });
    await enviar(onUpload);
    expect(await screen.findByText('Resultado da importação')).toBeInTheDocument();
    expect(screen.getByText('Pulados — nota já enviada').nextSibling).toHaveTextContent('2');
    expect(screen.getByText(/linha 4 · movimento 55 · nota já enviada/)).toBeInTheDocument();
    expect(screen.getByText(/linha 6 · CNPJ 12345678000199 · movimentos 70, 71/)).toBeInTheDocument();
    expect(screen.getByText(/já tinham a mensagem enviada/)).toBeInTheDocument();
  });

  it('avisa quando a mensagem da planilha ficou com valor divergente', async () => {
    const onUpload = vi.fn().mockResolvedValue({ success: true, resumo: { ...resumo, mensagem_divergente: 2 }, pulados: [], ambiguos: [] });
    await enviar(onUpload);
    expect(await screen.findByText(/cita outro valor e não pôde ser ajustado/)).toHaveTextContent(/^2 movimento/);
  });

  it('sem divergência não mostra o aviso', async () => {
    const onUpload = vi.fn().mockResolvedValue({ success: true, resumo: { ...resumo, mensagem_divergente: 0 }, pulados: [], ambiguos: [] });
    await enviar(onUpload);
    await screen.findByText('Resultado da importação');
    expect(screen.queryByText(/cita outro valor/)).not.toBeInTheDocument();
  });

  it('envia o motivo digitado junto das datas', async () => {
    const onUpload = vi.fn().mockResolvedValue({});
    render(<ImportButton onUpload={onUpload} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [ARQUIVO] });
    fireEvent.change(input);
    fireEvent.change(screen.getByLabelText('Data inicial'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Data final'), { target: { value: '2026-10-05' } });
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: 'valor errado na planilha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(onUpload).toHaveBeenCalled());
    expect(onUpload.mock.calls[0][1]).toMatchObject({ motivo: 'valor errado na planilha' });
  });

  it('400 "Informe o motivo": reabre o diálogo com o aviso, sem declarar sucesso', async () => {
    const onUpload = vi.fn().mockRejectedValue(new ApiError('Informe o motivo: esta importação altera movimentos já existentes. Nada foi alterado.', 400));
    await enviar(onUpload);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Informe o motivo/);
    expect(screen.queryByText('Resultado da importação')).toBeNull();
  });

  it('500 com parcial: diz o que foi e o que não foi aplicado', async () => {
    const onUpload = vi.fn().mockRejectedValue(
      new ApiError('Importação interrompida. Veja o que foi e o que não foi aplicado.', 500, [],
        { parcial: { atualizacoes_confirmadas: 5, linhas_novas_criadas: false } }));
    await enviar(onUpload);
    expect(await screen.findByText('Importação interrompida')).toBeInTheDocument();
    expect(screen.getAllByText(/Atualizações já confirmadas: 5/).length).toBeGreaterThan(0);
  });
});
