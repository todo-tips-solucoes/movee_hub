// impeccable rodada 10 (A7) — rótulo legível das permissões.
//
// Os casos aqui são os 34 códigos REAIS lidos do banco do hub em 2026-08-10,
// não amostra inventada: a regra do `consultar` depende de quais módulos têm
// `listar`, e essa distribuição é um fato do produto.
import { describe, expect, it } from 'vitest';
import { ehAltoImpacto, modulosComListar, rotuloPermissao } from './rotulo-permissao';

const CODIGOS_REAIS = [
  'dashboard.consultar',
  'motoristas.listar',
  'motoristas.consultar',
  'motoristas.criar',
  'motoristas.editar',
  'motoristas.excluir',
  'motoristas.importar',
  'motoristas.exportar',
  'motoristas.credencial',
  'faturamento.listar',
  'faturamento.consultar',
  'faturamento.exportar',
  'performance.listar',
  'performance.consultar',
  'performance.exportar',
  'importacoes.consultar',
  'importacoes.criar',
  'importacoes.importar',
  'importacoes.exportar',
  'envio_massa.consultar',
  'envio_massa.criar',
  'envio_massa.aprovar',
  'envio_massa.enviar',
  'envio_massa.gerenciar',
  'validacao_xml.validar',
  'usuarios.listar',
  'usuarios.consultar',
  'usuarios.criar',
  'usuarios.editar',
  'usuarios.excluir',
  'usuarios.gerenciar',
  'auditoria.consultar',
  'admin.gerenciar',
];

const COM_LISTAR = modulosComListar(CODIGOS_REAIS);

describe('modulosComListar', () => {
  it('encontra exatamente os 4 módulos que têm lista própria', () => {
    expect([...COM_LISTAR].sort()).toEqual([
      'faturamento',
      'motoristas',
      'performance',
      'usuarios',
    ]);
  });
});

describe('rotuloPermissao — o consultar ambíguo', () => {
  it('onde há lista, consultar é abrir um item', () => {
    expect(rotuloPermissao('motoristas.consultar', COM_LISTAR.has('motoristas'))).toBe(
      'Ver detalhes'
    );
    expect(rotuloPermissao('usuarios.consultar', COM_LISTAR.has('usuarios'))).toBe('Ver detalhes');
  });

  it('onde não há lista, consultar é entrar no módulo', () => {
    expect(rotuloPermissao('auditoria.consultar', COM_LISTAR.has('auditoria'))).toBe(
      'Acessar o módulo'
    );
    expect(rotuloPermissao('dashboard.consultar', COM_LISTAR.has('dashboard'))).toBe(
      'Acessar o módulo'
    );
    expect(rotuloPermissao('envio_massa.consultar', COM_LISTAR.has('envio_massa'))).toBe(
      'Acessar o módulo'
    );
  });
});

describe('rotuloPermissao — os demais verbos', () => {
  it('traduz cada verbo do catálogo real', () => {
    const casos: [string, string][] = [
      ['motoristas.listar', 'Ver a lista'],
      ['motoristas.criar', 'Cadastrar'],
      ['motoristas.editar', 'Editar'],
      ['motoristas.excluir', 'Excluir'],
      ['motoristas.exportar', 'Exportar (CSV)'],
      ['motoristas.importar', 'Importar planilha'],
      ['motoristas.credencial', 'Emitir credencial do app'],
      ['envio_massa.aprovar', 'Aprovar antes do disparo'],
      ['envio_massa.enviar', 'Disparar mensagens'],
      ['admin.gerenciar', 'Administrar tudo do módulo'],
      ['validacao_xml.validar', 'Validar arquivos XML'],
    ];
    for (const [codigo, esperado] of casos) {
      expect(rotuloPermissao(codigo, COM_LISTAR.has(codigo.split('.')[0]))).toBe(esperado);
    }
  });

  it('nenhum dos 34 códigos reais fica sem rótulo', () => {
    const semRotulo = CODIGOS_REAIS.filter(
      (c) => rotuloPermissao(c, COM_LISTAR.has(c.split('.')[0])) === c
    );
    expect(semRotulo, `sem tradução: ${semRotulo.join(', ')}`).toEqual([]);
  });

  it('verbo desconhecido devolve o código cru — feio, nunca errado', () => {
    // Permissão nova criada por migration futura, antes de alguém traduzir.
    expect(rotuloPermissao('motoristas.arquivar', true)).toBe('motoristas.arquivar');
    expect(rotuloPermissao('sem_ponto', false)).toBe('sem_ponto');
  });
});

describe('ehAltoImpacto', () => {
  it('marca o que concede mais do que o nome sugere, ou não tem volta', () => {
    expect(ehAltoImpacto('usuarios.gerenciar')).toBe(true);
    expect(ehAltoImpacto('envio_massa.enviar')).toBe(true);
    expect(ehAltoImpacto('motoristas.excluir')).toBe(true);
    expect(ehAltoImpacto('motoristas.credencial')).toBe(true);
  });

  it('não marca leitura nem cadastro comum', () => {
    expect(ehAltoImpacto('motoristas.listar')).toBe(false);
    expect(ehAltoImpacto('motoristas.criar')).toBe(false);
    expect(ehAltoImpacto('faturamento.exportar')).toBe(false);
  });
});
