// FASE 9 — a tela de importação do retorno da Transfeera.
//
// O que estes casos protegem, todos nascidos do arquivo REAL (2026-09-30):
//   - um export de período traz milhares de linhas de outros pagamentos; a
//     tela tem de AGREGAR por motivo, não listar (ficaria ilegível);
//   - `RETORNO_INCOMPLETO` não é erro de arquivo: é arquivo que não cobre o
//     lote. Dizer "arquivo inválido" aqui mandaria o operador procurar defeito
//     onde não tem, e ele precisa saber que NADA foi aplicado;
//   - `CABECALHO_INVALIDO` e `FORMATO_INVALIDO` precisam dizer o que fazer
//     (enviar o XLSX baixado da Transfeera, sem editar colunas), não "arquivo
//     inválido".
//   - o arquivo vai como BINÁRIO (`ArrayBuffer`): `File.text()` decodificaria
//     o ZIP como UTF-8 e o corromperia antes mesmo de chegar ao proxy.
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ImportarRetornoDialog,
  useImportarRetornoDialog,
  rotularIgnoradas,
} from './adiantamento-importar-retorno-dialog';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';

const mockImportar = vi.fn();

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return { ...actual, importarRetornoLote: (...args: unknown[]) => mockImportar(...args) };
});

// O backend passou a AGREGAR (gate owasp-security, 2026-10-01): o `ID de
// integração` é texto livre do parceiro e carregava nome de pessoas. Aqui ficou
// só a tradução do motivo técnico para frase legível.
describe('rotularIgnoradas — tradução dos motivos que o backend agrega', () => {
  it('traduz cada motivo conhecido, preservando a contagem e a ordem do servidor', () => {
    expect(rotularIgnoradas([
      { motivo: 'ID_INTEGRACAO_INVALIDO', total: 3843 },
      { motivo: 'JA_APLICADO', total: 2 },
      { motivo: 'NAO_PERTENCE_AO_LOTE', total: 1 },
    ])).toEqual([
      { rotulo: 'Linhas de outros pagamentos (sem ID de integração do hub)', total: 3843 },
      { rotulo: 'Já conciliados numa importação anterior', total: 2 },
      { rotulo: 'Pagamentos de outro lote', total: 1 },
    ]);
  });

  it('status desconhecido carrega o valor CRU do arquivo, nunca traduzido', () => {
    expect(rotularIgnoradas([{ motivo: 'STATUS_DESCONHECIDO:EM_ANALISE', total: 1 }])[0].rotulo)
      .toContain('EM_ANALISE');
  });

  it('valor ambíguo nomeia o texto da célula e diz o que fazer', () => {
    const r = rotularIgnoradas([{ motivo: 'VALOR_AMBIGUO:1.234', total: 1 }])[0].rotulo;
    expect(r).toContain('1.234');
    expect(r).toContain('Reexporte');
  });

  it('motivo que não conhecemos aparece cru, sem inventar texto', () => {
    expect(rotularIgnoradas([{ motivo: 'MOTIVO_NOVO_DO_BACKEND', total: 1 }])[0].rotulo)
      .toBe('MOTIVO_NOVO_DO_BACKEND');
  });
});

/** Bytes que NÃO sobrevivem a `text()`: assinatura ZIP + 0x80..0xFF + NUL. */
const BYTES_XLSX = (() => {
  const b = new Uint8Array(4 + 128 + 2);
  b.set([0x50, 0x4b, 0x03, 0x04]);
  for (let i = 0; i < 128; i += 1) b[4 + i] = 0x80 + i;
  b[132] = 0x00;
  b[133] = 0xc3;
  return b;
})();
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ARQUIVO_XLSX = new File([BYTES_XLSX], 'retorno.xlsx', { type: XLSX_MIME });

/** Monta o diálogo já aberto com um arquivo escolhido, sem depender de um
 *  `File` real no jsdom para o caminho de leitura. */
function Harness({ onSucesso = () => {} }: { onSucesso?: () => void }) {
  const d = useImportarRetornoDialog({ loteId: 1, onSucesso });
  // abre e injeta o arquivo na primeira renderização
  if (!d.open) {
    d.abrir();
    d.escolher(ARQUIVO_XLSX);
  }
  return <ImportarRetornoDialog d={d} />;
}

describe('ImportarRetornoDialog — o que o operador lê', () => {
  beforeEach(() => {
    mockImportar.mockReset();
  });

  it('sucesso: mostra quantos conciliou e o resumo do que ignorou', async () => {
    mockImportar.mockResolvedValue({
      aplicadas: 1,
      ignoradas: 3843,
      ignoradasPorMotivo: [{ motivo: 'ID_INTEGRACAO_INVALIDO', total: 3843 }],
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Importar retorno/i })).toBeEnabled());
    screen.getByRole('button', { name: /Importar retorno/i }).click();

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status').textContent).toContain('1 pagamento conciliado');
    // 3.843 formatado em pt-BR, agregado numa linha só
    expect(screen.getByRole('status').textContent).toContain('3.843');
  });

  it('RETORNO_INCOMPLETO: diz quantos faltam e que NADA foi aplicado', async () => {
    mockImportar.mockRejectedValue(
      new AdiantamentosApiError(409, 'incompleto', 'RETORNO_INCOMPLETO', undefined, [3, 7])
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Importar retorno/i })).toBeEnabled());
    screen.getByRole('button', { name: /Importar retorno/i }).click();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const texto = screen.getByRole('alert').textContent ?? '';
    expect(texto).toContain('2 pagamentos');
    expect(texto).toMatch(/[Nn]ada foi aplicado/);
  });

  it('RETORNO_INCOMPLETO com linha recusada: NOMEIA a causa (valor ambíguo) e não manda reexportar o período', async () => {
    mockImportar.mockRejectedValue(
      new AdiantamentosApiError(
        409, 'incompleto', 'RETORNO_INCOMPLETO', undefined, [3], undefined,
        [{ motivo: 'VALOR_AMBIGUO:1.234', total: 1 }, { motivo: 'ID_INTEGRACAO_INVALIDO', total: 3800 }]
      )
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Importar retorno/i })).toBeEnabled());
    screen.getByRole('button', { name: /Importar retorno/i }).click();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const texto = screen.getByRole('alert').textContent ?? '';
    expect(texto).toContain('1 pagamento');
    expect(texto).toContain('Valor sem casas decimais');
    expect(texto).toContain('1.234');
    expect(texto).not.toMatch(/exporte o per/i);
    expect(texto).not.toContain('3.800'); // ruído de export de período não é causa
  });

  it('CABECALHO_INVALIDO: instrui a enviar o XLSX baixado da Transfeera, sem editar as colunas', async () => {
    mockImportar.mockRejectedValue(
      new AdiantamentosApiError(400, 'genérica', 'ARQUIVO_INVALIDO', undefined, undefined, 'CABECALHO_INVALIDO')
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Importar retorno/i })).toBeEnabled());
    screen.getByRole('button', { name: /Importar retorno/i }).click();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const texto = screen.getByRole('alert').textContent ?? '';
    expect(texto).toMatch(/XLSX/);
    expect(texto).not.toMatch(/CSV/); // a instrução antiga mandaria exportar justo o formato recusado
  });

  it('FORMATO_INVALIDO: diz que não é uma planilha XLSX válida', async () => {
    mockImportar.mockRejectedValue(
      new AdiantamentosApiError(400, 'genérica', 'ARQUIVO_INVALIDO', undefined, undefined, 'FORMATO_INVALIDO')
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Importar retorno/i })).toBeEnabled());
    screen.getByRole('button', { name: /Importar retorno/i }).click();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/não é uma planilha XLSX válida/);
  });

  it('envia o arquivo como ArrayBuffer com os MESMOS bytes (nunca text(), nunca base64)', async () => {
    mockImportar.mockResolvedValue({ aplicadas: 0, ignoradas: 0, ignoradasPorMotivo: [] });
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Importar retorno/i })).toBeEnabled());
    screen.getByRole('button', { name: /Importar retorno/i }).click();

    await waitFor(() => expect(mockImportar).toHaveBeenCalledTimes(1));
    const [, corpo] = mockImportar.mock.calls[0];
    // `toString` e não `instanceof`: o ArrayBuffer do jsdom é de outro realm.
    expect(Object.prototype.toString.call(corpo)).toBe('[object ArrayBuffer]');
    expect(corpo.byteLength).toBe(ARQUIVO_XLSX.size);
    expect(Array.from(new Uint8Array(corpo as ArrayBuffer))).toEqual(Array.from(BYTES_XLSX));
  });

  it('o seletor aceita .xlsx e o rótulo diz "Arquivo XLSX"', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Arquivo XLSX') as HTMLInputElement;
    expect(input.accept).toContain('.xlsx');
    expect(input.accept).toContain(XLSX_MIME);
    expect(input.accept).not.toContain('csv');
  });

  it('arquivo acima de 10 MB é barrado ANTES do envio', async () => {
    const { result } = renderHook(() => useImportarRetornoDialog({ loteId: 1, onSucesso: () => {} }));
    const grande = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'grande.xlsx', { type: XLSX_MIME });
    act(() => result.current.escolher(grande));
    expect(result.current.arquivo).toBeNull();
    expect(result.current.erro).toMatch(/10 MB/);
    expect(mockImportar).not.toHaveBeenCalled();
  });
});
