// FASE 9 — a tela de importação do retorno da Transfeera.
//
// O que estes casos protegem, todos nascidos do arquivo REAL (2026-09-30):
//   - um export de período traz milhares de linhas de outros pagamentos; a
//     tela tem de AGREGAR por motivo, não listar (ficaria ilegível);
//   - `RETORNO_INCOMPLETO` não é erro de arquivo: é arquivo que não cobre o
//     lote. Dizer "arquivo inválido" aqui mandaria o operador procurar defeito
//     onde não tem, e ele precisa saber que NADA foi aplicado;
//   - `CABECALHO_INVALIDO` precisa dizer o que fazer (exportar em CSV sem
//     editar colunas) — foi o erro que o XLSX de movimentações produziria.
import { render, screen, waitFor } from '@testing-library/react';
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

  it('motivo que não conhecemos aparece cru, sem inventar texto', () => {
    expect(rotularIgnoradas([{ motivo: 'MOTIVO_NOVO_DO_BACKEND', total: 1 }])[0].rotulo)
      .toBe('MOTIVO_NOVO_DO_BACKEND');
  });
});

/** Monta o diálogo já aberto com um arquivo escolhido, sem depender de um
 *  `File` real no jsdom para o caminho de leitura. */
function Harness({ onSucesso = () => {} }: { onSucesso?: () => void }) {
  const d = useImportarRetornoDialog({ loteId: 1, onSucesso });
  // abre e injeta o arquivo na primeira renderização
  if (!d.open) {
    d.abrir();
    d.escolher(new File(['ID da transferência,ID de integração\n1,ADV-000003'], 'retorno.csv', { type: 'text/csv' }));
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

  it('CABECALHO_INVALIDO: instrui a exportar em CSV, em vez de só "arquivo inválido"', async () => {
    mockImportar.mockRejectedValue(
      new AdiantamentosApiError(400, 'genérica', 'ARQUIVO_INVALIDO', undefined, undefined, 'CABECALHO_INVALIDO')
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Importar retorno/i })).toBeEnabled());
    screen.getByRole('button', { name: /Importar retorno/i }).click();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/CSV/);
  });

  it('envia o CSV como TEXTO, nunca em base64', async () => {
    mockImportar.mockResolvedValue({ aplicadas: 0, ignoradas: 0, ignoradasPorMotivo: [] });
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Importar retorno/i })).toBeEnabled());
    screen.getByRole('button', { name: /Importar retorno/i }).click();

    await waitFor(() => expect(mockImportar).toHaveBeenCalledTimes(1));
    const [, corpo] = mockImportar.mock.calls[0];
    // O conteúdo do File do Harness, cru. Em base64 começaria com "SUQg…".
    expect(corpo).toContain('ID da transferência');
    expect(corpo).toContain('ADV-000003');
  });
});
