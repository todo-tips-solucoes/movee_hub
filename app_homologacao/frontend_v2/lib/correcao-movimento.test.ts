import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client';
import { descreverCorrecao, descreverErroCorrecao, descreverInterrompida } from './correcao-movimento';

describe('descreverCorrecao', () => {
  it('atualizado limpo = sucesso', () => {
    expect(descreverCorrecao({ resultado: 'atualizado', mensagem_ajustada: true }).tom).toBe('sucesso');
  });
  it('aviso de mensagem ou mensagem com valor antigo = aviso', () => {
    expect(descreverCorrecao({ resultado: 'atualizado', aviso: 'revise' }).tom).toBe('aviso');
    expect(descreverCorrecao({ resultado: 'atualizado', mensagem_valor_antigo: true }).texto).toMatch(/valor antigo/);
  });
  it('corpo sem resultado nunca é sucesso', () => {
    expect(descreverCorrecao({}).tom).toBe('aviso');
    expect(descreverCorrecao(undefined).tom).toBe('aviso');
  });
});

describe('descreverErroCorrecao', () => {
  it('409 nota enviada / mov fechado / 404 / 500', () => {
    expect(descreverErroCorrecao(new ApiError('x', 409, [], { resultado: 'pulado_nota_enviada' }))).toMatch(/Cancele a nota/);
    expect(descreverErroCorrecao(new ApiError('x', 409, [], { resultado: 'pulado_mov_fechado' }))).toMatch(/fechado/);
    expect(descreverErroCorrecao(new ApiError('x', 404, [], { resultado: 'nao_encontrado' }))).toMatch(/não encontrado/);
    expect(descreverErroCorrecao(new ApiError('Falhou.', 500))).toMatch(/Nada foi confirmado/);
  });
});

describe('descreverInterrompida', () => {
  it('500 com parcial vira texto; erro comum, null', () => {
    const e = new ApiError('Importação interrompida.', 500, [], { parcial: { atualizacoes_confirmadas: 3, linhas_novas_criadas: false } });
    expect(descreverInterrompida(e)).toMatch(/3.*NÃO criadas/);
    expect(descreverInterrompida(new Error('x'))).toBeNull();
  });
});
