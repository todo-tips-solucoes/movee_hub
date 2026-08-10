// impeccable rodada 8 (P2) — título da aba por rota.
//
// Medido antes: 13 rotas, 1 único `document.title`, e ele nomeava o produto
// legado. A parte que pode quebrar em silêncio é o casamento de rota: como
// `/hub/dashboard` (módulo "Painel Geral") é prefixo de TODAS as outras, um
// match ingênuo por prefixo daria "Painel Geral" em toda tela do hub — um
// título errado é pior que o título repetido que estamos consertando.
import { describe, expect, it } from 'vitest';
import { resolverTitulo } from './titulo-da-rota';

const MODULOS = [
  { codigo: 'dashboard', nome: 'Painel Geral' },
  { codigo: 'auditoria', nome: 'Auditoria' },
  { codigo: 'importacoes', nome: 'Importações' },
  { codigo: 'usuarios', nome: 'Usuários' },
];

describe('resolverTitulo', () => {
  it('nomeia o módulo da rota, com o produto certo no sufixo', () => {
    expect(resolverTitulo('/hub/dashboard/auditoria', MODULOS)).toBe('Auditoria · Hub de Frota');
  });

  it('o prefixo mais longo vence — "Painel Geral" não sequestra as demais rotas', () => {
    // `/hub/dashboard` casa com todas por prefixo; sem o desempate por
    // comprimento, esta asserção devolveria "Painel Geral · Hub de Frota".
    expect(resolverTitulo('/hub/dashboard/importacoes', MODULOS)).toBe(
      'Importações · Hub de Frota'
    );
  });

  it('a raiz do painel continua sendo o módulo dashboard', () => {
    expect(resolverTitulo('/hub/dashboard', MODULOS)).toBe('Painel Geral · Hub de Frota');
  });

  it('subrota herda o título do módulo', () => {
    expect(resolverTitulo('/hub/dashboard/importacoes/123', MODULOS)).toBe(
      'Importações · Hub de Frota'
    );
    expect(resolverTitulo('/hub/dashboard/usuarios/papeis', MODULOS)).toBe(
      'Usuários · Hub de Frota'
    );
  });

  it('rota sem módulo correspondente cai no nome do produto, nunca no legado', () => {
    expect(resolverTitulo('/hub/login', MODULOS)).toBe('Hub de Frota');
  });

  it('sem módulos carregados ainda, não inventa título', () => {
    expect(resolverTitulo('/hub/dashboard/auditoria', [])).toBe('Hub de Frota');
  });
});
