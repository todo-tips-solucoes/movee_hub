// impeccable rodada 13 — a trava contra deriva entre a lista mostrada ao
// usuário e a que o backend exige.
//
// Este teste é a razão de a cópia em `importacoes-formato.ts` ser aceitável:
// ele importa o módulo REAL do backend (mesmo monorepo) e compara nome a nome,
// posição a posição. Se alguém mudar o header lá, a tela não continua
// ensinando o formato antigo em silêncio — o gate quebra aqui.
//
// Comparar com uma cópia da lista dentro do próprio teste não provaria nada:
// seria a mesma fonte checando a si mesma.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { COLUNAS_IMPORTACAO, SEPARADOR_CSV, csvModelo, nomeArquivoModelo } from './importacoes-formato';

const require = createRequire(import.meta.url);
const normalizer = require('../../../backend/lib/hub-import-normalizer.js');

describe('colunas de importação — paridade com o backend', () => {
  it('faturamento bate nome e ORDEM com HEADER_FATURAMENTO', () => {
    expect(COLUNAS_IMPORTACAO.faturamento).toEqual(normalizer.HEADER_FATURAMENTO);
  });

  it('performance bate nome e ORDEM com HEADER_PERFORMANCE', () => {
    expect(COLUNAS_IMPORTACAO.performance).toEqual(normalizer.HEADER_PERFORMANCE);
  });

  it('o modelo baixado passa na validação de cabeçalho do backend', () => {
    // Prova ponta a ponta do artefato que o usuário recebe: o próprio
    // validador do backend aprova o cabeçalho do modelo.
    for (const tipo of ['faturamento', 'performance'] as const) {
      const cabecalho = csvModelo(tipo).trim().split(SEPARADOR_CSV);
      expect(normalizer.validarHeader(cabecalho, tipo).valido, tipo).toBe(true);
    }
  });

  it('o modelo é rejeitado se a ordem mudar (contraprova)', () => {
    // Sem isto, o teste acima passaria com um validador que aceita qualquer
    // coisa — e é justamente a ORDEM que a tela precisa ensinar.
    const trocado = [...COLUNAS_IMPORTACAO.faturamento];
    [trocado[0], trocado[1]] = [trocado[1], trocado[0]];
    expect(normalizer.validarHeader(trocado, 'faturamento').valido).toBe(false);
  });

  it('o nome do arquivo identifica o tipo', () => {
    expect(nomeArquivoModelo('performance')).toBe('modelo-performance.csv');
  });
});
