// hub-importacoes (S4) FASE 6 task 6.4.3 — paridade DTO↔contrato (mesmo
// padrão de `lib/hub/me-dto.ts`, mas aqui o alvo é o SHAPE (não tradução de
// case, já feita no backend — ver cabeçalho de importacoes-dto.ts).
import { describe, expect, it } from 'vitest';
import {
  extensaoDoArquivo,
  parseImportacaoDetalhe,
  parseImportacaoErroItem,
  parseImportacaoErrosResponse,
  parseImportacaoListItem,
  parseImportacaoListResponse,
  validarArquivoImportacao,
  STATUS_CANCELAVEL,
  STATUS_EM_ANDAMENTO,
  STATUS_REPROCESSAVEL,
  rotuloIntervaloImportacao,
} from './importacoes-dto';

const ITEM_VALIDO = {
  id: 1,
  tipo: 'faturamento',
  status: 'completed',
  nomeArquivo: 'arquivo.csv',
  totalLinhas: 100,
  linhasValidas: 95,
  linhasInvalidas: 5,
  dataReferencia: '2026-07-01',
  dataReferenciaFim: '2026-07-03',
  criadoPor: 7,
  iniciadoEm: '2026-07-01T10:00:00Z',
  concluidoEm: '2026-07-01T10:05:00Z',
  duracaoSegundos: 300,
  aguardandoLock: false,
};

describe('parseImportacaoListItem', () => {
  it('aceita um item completo, espelhando o contrato (contracts/importacoes-api.md §GET /importacoes)', () => {
    const parsed = parseImportacaoListItem(ITEM_VALIDO);
    expect(parsed).toEqual(ITEM_VALIDO);
  });

  it('preenche campos nulos ausentes com null (nunca undefined, nunca lança)', () => {
    const parsed = parseImportacaoListItem({ id: 2, tipo: 'performance', status: 'pending' });
    expect(parsed.nomeArquivo).toBeNull();
    expect(parsed.totalLinhas).toBeNull();
    expect(parsed.aguardandoLock).toBe(false);
  });

  it('rejeita item sem id/tipo/status (shape incompatível com o contrato)', () => {
    expect(() => parseImportacaoListItem({ tipo: 'faturamento', status: 'pending' })).toThrow(TypeError);
    expect(() => parseImportacaoListItem(null)).toThrow(TypeError);
    expect(() => parseImportacaoListItem('string')).toThrow(TypeError);
  });

  it('aguardandoLock (dec-032/CHK013): só true quando o backend explicitamente diz true', () => {
    expect(parseImportacaoListItem({ ...ITEM_VALIDO, aguardandoLock: true }).aguardandoLock).toBe(true);
    expect(parseImportacaoListItem({ ...ITEM_VALIDO, aguardandoLock: undefined }).aguardandoLock).toBe(false);
  });
});

describe('parseImportacaoListResponse', () => {
  it('mapeia items[] + paginação', () => {
    const resposta = parseImportacaoListResponse({
      items: [ITEM_VALIDO],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(resposta.items).toHaveLength(1);
    expect(resposta.total).toBe(1);
  });

  it('rejeita resposta sem items[]', () => {
    expect(() => parseImportacaoListResponse({ total: 0 })).toThrow(TypeError);
  });
});

describe('parseImportacaoDetalhe', () => {
  it('mapeia contadores aninhados (contract §GET /importacoes/:id)', () => {
    const detalhe = parseImportacaoDetalhe({
      id: 1,
      tipo: 'faturamento',
      status: 'processing',
      contadores: { total: 10, validas: 8, invalidas: 2 },
      dataReferencia: '2026-07-01',
      dataReferenciaFim: null,
      iniciadoEm: '2026-07-01T10:00:00Z',
      concluidoEm: null,
      duracaoSegundos: null,
      erroResumo: null,
    });
    expect(detalhe.contadores).toEqual({ total: 10, validas: 8, invalidas: 2 });
  });

  it('degrada contadores ausentes para null (nunca lança por causa disso)', () => {
    const detalhe = parseImportacaoDetalhe({ id: 1, tipo: 'faturamento', status: 'pending' });
    expect(detalhe.contadores).toEqual({ total: null, validas: null, invalidas: null });
  });

  it('rejeita shape sem id/tipo/status', () => {
    expect(() => parseImportacaoDetalhe({})).toThrow(TypeError);
  });
});

describe('parseImportacaoErroItem / parseImportacaoErrosResponse', () => {
  it('mapeia 1 erro (valorMascarado nunca bruto)', () => {
    const item = parseImportacaoErroItem({
      numeroLinha: 5,
      campo: 'cnpj',
      motivo: 'formato inválido',
      valorMascarado: '12***89',
    });
    expect(item.valorMascarado).toBe('12***89');
  });

  it('rejeita erro sem numeroLinha', () => {
    expect(() => parseImportacaoErroItem({ campo: 'x' })).toThrow(TypeError);
  });

  it('mapeia resposta paginada de erros', () => {
    const resposta = parseImportacaoErrosResponse({
      items: [{ numeroLinha: 1, campo: null, motivo: 'x', valorMascarado: null }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(resposta.items).toHaveLength(1);
  });
});

describe('máquina de estados — conjuntos derivados do contrato', () => {
  it('STATUS_EM_ANDAMENTO cobre exatamente pending/validating/processing', () => {
    expect([...STATUS_EM_ANDAMENTO].sort()).toEqual(['pending', 'processing', 'validating'].sort());
  });

  it('STATUS_REPROCESSAVEL cobre failed/cancelled e o dia que entrou torto', () => {
    expect([...STATUS_REPROCESSAVEL].sort()).toEqual(['cancelled', 'completed_with_errors', 'failed']);
    // `completed` fica de fora: não há o que refazer.
    expect(STATUS_REPROCESSAVEL.has('completed')).toBe(false);
  });

  it('STATUS_CANCELAVEL cobre pending/validating/processing', () => {
    expect([...STATUS_CANCELAVEL].sort()).toEqual(['pending', 'processing', 'validating'].sort());
  });
});

describe('validarArquivoImportacao (6.3.2 — espelha 3.1.1-3.1.3 do backend)', () => {
  it('aceita .csv dentro do limite de tamanho', () => {
    expect(validarArquivoImportacao({ name: 'a.csv', size: 1024 })).toEqual({ valido: true });
  });

  it('aceita .zip dentro do limite de tamanho', () => {
    expect(validarArquivoImportacao({ name: 'a.zip', size: 1024 })).toEqual({ valido: true });
  });

  it('rejeita extensão não suportada', () => {
    expect(validarArquivoImportacao({ name: 'a.txt', size: 1024 })).toEqual({
      valido: false,
      motivo: 'extensao_invalida',
    });
  });

  it('rejeita arquivo acima de 20 MB', () => {
    expect(validarArquivoImportacao({ name: 'a.csv', size: 20 * 1024 * 1024 + 1 })).toEqual({
      valido: false,
      motivo: 'tamanho_excedido',
    });
  });

  it('rejeita arquivo vazio', () => {
    expect(validarArquivoImportacao({ name: 'a.csv', size: 0 })).toEqual({
      valido: false,
      motivo: 'arquivo_vazio',
    });
  });

  it('extensaoDoArquivo é case-insensitive', () => {
    expect(extensaoDoArquivo('ARQUIVO.CSV')).toBe('.csv');
    expect(extensaoDoArquivo('sem-extensao')).toBe('');
  });
});

// 0056: a importação passou a registrar o INTERVALO de datas do arquivo. Mostrar
// só a primeira data escondia que o arquivo de faturamento de 28/08/2026 trazia
// competências de 25 a 28/08 — e foi o que o rotulou como "27/08".
describe('rotuloIntervaloImportacao', () => {
  const fmt = (d: string) => d.split('-').reverse().join('/');

  it('pontas diferentes viram intervalo', () => {
    expect(rotuloIntervaloImportacao('2026-08-25', '2026-08-28', fmt)).toBe('25/08/2026 – 28/08/2026');
  });

  it('arquivo de um dia só mostra uma data', () => {
    expect(rotuloIntervaloImportacao('2026-08-28', '2026-08-28', fmt)).toBe('28/08/2026');
  });

  it('importação anterior à migration (sem fim) mostra uma data', () => {
    expect(rotuloIntervaloImportacao('2026-08-28', null, fmt)).toBe('28/08/2026');
  });

  it('sem data nenhuma devolve string vazia, nunca "null"', () => {
    expect(rotuloIntervaloImportacao(null, null, fmt)).toBe('');
  });
});
