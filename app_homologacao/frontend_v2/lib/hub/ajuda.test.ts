// Lógica pura da Central de Ajuda + integridade do JSON contra o que a tela
// renderiza (irmão de frontend_motorista/lib/ajuda.test.ts).
import { describe, expect, it } from 'vitest';
import {
  CAMPOS_POR_BLOCO, conteudo, filtrarSecoes, indice, normalizar, partirInline, ROTULO_AVISO, semMarcas,
  type Secao,
} from './ajuda';

const secoes = conteudo.secoes;
const blocos = secoes.flatMap((s) => s.blocos);

describe('conteúdo', () => {
  it('tem as 27 seções do manual, com id único', () => {
    expect(secoes).toHaveLength(27);
    expect(new Set(secoes.map((s) => s.id)).size).toBe(27);
  });

  it('todo bloco é de um tipo que a tela sabe renderizar, com campos conhecidos', () => {
    for (const s of secoes) {
      for (const b of s.blocos) {
        const campos = CAMPOS_POR_BLOCO[b.bloco];
        expect(campos, `${s.id}: tipo de bloco "${b.bloco}"`).toBeDefined();
        for (const k of Object.keys(b)) expect(campos, `${s.id}.${b.bloco}.${k}`).toContain(k);
      }
    }
  });

  it('todo tipo de aviso tem rótulo', () => {
    for (const b of blocos) if (b.bloco === 'aviso') expect(b.tipo in ROTULO_AVISO, b.tipo).toBe(true);
  });

  it('tabelas têm todas as linhas com o número de colunas do cabeçalho', () => {
    for (const b of blocos) {
      if (b.bloco === 'tabela') for (const l of b.linhas) expect(l).toHaveLength(b.cabecalho.length);
    }
  });

  it('nenhuma marcação inline sobra crua e todo link aponta para uma seção', () => {
    const ids = new Set(secoes.map((s) => s.id));
    const strings = JSON.stringify(secoes.map((s) => s.blocos)); // só para achar links
    for (const m of strings.matchAll(/\]\(#([^)]+)\)/g)) expect(ids.has(m[1]), m[1]).toBe(true);
    const todas: string[] = [];
    const colher = (v: unknown): void => {
      if (typeof v === 'string') todas.push(v);
      else if (Array.isArray(v)) v.forEach(colher);
      else if (v && typeof v === 'object') Object.values(v).forEach(colher);
    };
    colher(blocos);
    for (const t of todas) expect(semMarcas(t), t).not.toMatch(/\*|`|\]\(/);
  });
});

describe('partirInline', () => {
  it('separa negrito, ênfase, código e link; o resto é texto', () => {
    expect(partirInline('a **b** *c* `d` [e](#f) g')).toEqual([
      { t: 'txt', v: 'a ' }, { t: 'forte', v: 'b' }, { t: 'txt', v: ' ' }, { t: 'enfase', v: 'c' },
      { t: 'txt', v: ' ' }, { t: 'codigo', v: 'd' }, { t: 'txt', v: ' ' }, { t: 'link', v: 'e', id: 'f' },
      { t: 'txt', v: ' g' },
    ]);
  });

  it('HTML no texto continua texto', () => {
    expect(partirInline('<b>x</b>')).toEqual([{ t: 'txt', v: '<b>x</b>' }]);
  });
});

describe('filtrarSecoes', () => {
  it('busca vazia devolve todas', () => {
    expect(filtrarSecoes(secoes, '')).toHaveLength(27);
    expect(filtrarSecoes(secoes, '   ')).toHaveLength(27);
  });

  it('ignora acento e caixa', () => {
    expect(normalizar('Prévia')).toBe('previa');
    expect(filtrarSecoes(secoes, 'TRANSFEERA').length).toBeGreaterThan(0);
    expect(filtrarSecoes(secoes, 'limitacoes conhecidas').map((s) => s.id)).toContain('limitacoes');
  });

  it('exige todas as palavras e acha texto de dentro de tabela e de aviso', () => {
    const a = filtrarSecoes(secoes, 'transfeera');
    const b = filtrarSecoes(secoes, 'transfeera xyzinexistente');
    expect(a.length).toBeGreaterThan(0);
    expect(b).toHaveLength(0);
    // "Nota fiscal reprovada" só aparece numa célula de tabela do ciclo.
    expect(filtrarSecoes(secoes, 'nota fiscal reprovada').map((s) => s.id)).toContain('ciclo');
  });

  it('procurar pelo CÓDIGO do erro acha a seção (suporte recebe o código num print/log)', () => {
    const achou = (c: string) => filtrarSecoes(secoes, c).map((s) => s.id);
    expect(achou('PREVIA_DESATUALIZADA')).toContain('erros');
    expect(achou('transicao_invalida')).toContain('erros');
    expect(achou('NOTA_REPROVADA')).toContain('ciclo');
    expect(achou('APURACAO_ABERTA')).toContain('ciclo');
    for (const c of ['ITENS_EM_OUTRO_LOTE', 'RETORNO_INCOMPLETO', 'CABECALHO_INVALIDO', 'PERMISSAO_NEGADA', 'APURACAO_FORA_DE_ORDEM', 'APURACAO_COM_PENDENCIAS', 'PERIODO_EM_ABERTO', 'LIMITE_EXCEDIDO', 'NAO_AUTENTICADO']) {
      expect(achou(c), c).toContain('erros');
    }
    for (const c of ['JA_EM_LOTE', 'JA_PAGO_CONCILIADO', 'NOTA_PENDENTE', 'SEM_CONTA', 'VALOR_INVALIDO']) expect(achou(c), c).toContain('ciclo');
  });

  it('a busca não casa com a marcação, só com o texto', () => {
    const s: Secao = { id: 'x', titulo: 'T', grupo: 'G', blocos: [{ bloco: 'texto', texto: 'veja [aqui](#oculto)' }] };
    expect(filtrarSecoes([s], 'oculto')).toHaveLength(0);
    expect(filtrarSecoes([s], 'aqui')).toHaveLength(1);
  });
});

describe('indice', () => {
  it('agrupa na ordem do manual e conta todas as seções', () => {
    const g = indice(secoes);
    expect(g.map((x) => x.grupo)).toEqual(['Começar', 'Painel Envio em Massa', 'Movee Hub', 'App do motorista', 'Referência']);
    expect(g.flatMap((x) => x.itens)).toHaveLength(27);
  });

  it('o número é a posição no manual mesmo com o filtro ativo', () => {
    const filtradas = filtrarSecoes(secoes, 'antecipacao'); // hub-config e limitacoes
    const itens = indice(filtradas, secoes).flatMap((x) => x.itens);
    expect(itens.map((i) => i.id)).toEqual(['hub-config', 'limitacoes']);
    expect(itens.map((i) => i.numero)).toEqual([17, 27]);
  });
});
