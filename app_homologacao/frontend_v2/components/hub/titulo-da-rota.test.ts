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

// impeccable rodada 9 (P2) — medido: `/admin` e `/perfil` anunciavam "Painel
// Geral · Hub de Frota". Não são módulos do `/me`, então o casamento por
// prefixo caía em `/hub/dashboard`, e a aba dizia o nome de outra tela.
describe('resolverTitulo — rotas que não são módulos', () => {
  it('usa o h1 da própria tela quando a rota não casa exatamente com um módulo', () => {
    expect(resolverTitulo('/hub/dashboard/admin', MODULOS, 'Administração da plataforma')).toBe(
      'Administração da plataforma · Hub de Frota'
    );
  });

  it('módulo exato manda mais que o h1 — o nome vem do /me, não da tela', () => {
    // Se o h1 vencesse aqui, renomear um módulo no banco deixaria de renomear
    // a aba, que é a propriedade pela qual esta função existe.
    expect(resolverTitulo('/hub/dashboard/auditoria', MODULOS, 'Trilha de auditoria')).toBe(
      'Auditoria · Hub de Frota'
    );
  });

  it('h1 vazio ou só espaços não vira título', () => {
    expect(resolverTitulo('/hub/dashboard/admin', MODULOS, '   ')).toBe(
      'Painel Geral · Hub de Frota'
    );
    expect(resolverTitulo('/hub/dashboard/admin', MODULOS, null)).toBe(
      'Painel Geral · Hub de Frota'
    );
  });

  it('subrota de módulo com h1 próprio passa a nomear a tela, não o módulo', () => {
    // Mudança deliberada da r9: "Papéis e permissões" é mais preciso que
    // "Usuários" para quem tem as duas abas abertas.
    expect(resolverTitulo('/hub/dashboard/usuarios/papeis', MODULOS, 'Papéis e permissões')).toBe(
      'Papéis e permissões · Hub de Frota'
    );
  });
});
