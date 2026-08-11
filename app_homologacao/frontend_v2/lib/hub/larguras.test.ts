// impeccable rodada 18 (h4) — a regra de largura vira gate.
//
// Corrigir as três telas fora do padrão resolveria hoje e nada impediria a
// próxima tela de inventar a sua largura — foi assim que se chegou a cinco.
// Este teste lê as páginas REAIS do hub e exige que o container use uma das
// larguras nomeadas. Ele falha por adição (tela nova com largura inventada) e
// por edição (alguém troca a classe na mão).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LARGURAS_PERMITIDAS } from './larguras';

const RAIZ = join(process.cwd(), 'app/hub');

function paginas(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return paginas(caminho);
    return nome === 'page.tsx' ? [caminho] : [];
  });
}

/** A largura do container é a PRIMEIRA `max-w-*` da linha com `mx-auto`. */
function larguraDoContainer(fonte: string): string | null {
  for (const linha of fonte.split('\n')) {
    if (!linha.includes('mx-auto')) continue;
    const comConstante = linha.match(/\$\{(LARGURA_[A-Z]+)\}/);
    if (comConstante) return comConstante[1];
    const literal = linha.match(/max-w-\[?[a-z0-9.]+\]?/);
    if (literal) return literal[0];
  }
  return null;
}

describe('larguras de container das páginas do hub', () => {
  const arquivos = paginas(RAIZ);

  it('encontra as páginas (senão o teste passaria por vacuidade)', () => {
    expect(arquivos.length).toBeGreaterThan(10);
  });

  it('toda página usa uma largura nomeada, ou nenhuma', () => {
    const foraDoPadrao: string[] = [];
    for (const arquivo of arquivos) {
      const largura = larguraDoContainer(readFileSync(arquivo, 'utf8'));
      // `null` = a página não tem container próprio (herda do layout); é uma
      // decisão válida, não uma largura inventada.
      if (largura === null) continue;
      const permitida =
        largura.startsWith('LARGURA_') || (LARGURAS_PERMITIDAS as readonly string[]).includes(largura);
      if (!permitida) foraDoPadrao.push(`${arquivo.replace(RAIZ, '')} → ${largura}`);
    }
    expect(foraDoPadrao, `larguras fora da regra:\n${foraDoPadrao.join('\n')}`).toEqual([]);
  });

  it('as telas de lista concordam entre si', () => {
    // O sintoma que a crítica viu: navegar entre listas movia a margem
    // lateral. Estas seis são a mesma classe de tela.
    const listas = ['envio_massa', 'importacoes', 'motoristas', 'faturamento', 'performance', 'auditoria'];
    const larguras = listas.map((tela) => {
      const fonte = readFileSync(join(RAIZ, 'dashboard', tela, 'page.tsx'), 'utf8');
      return `${tela}:${larguraDoContainer(fonte)}`;
    });
    const distintas = new Set(larguras.map((l) => l.split(':')[1]));
    expect(distintas.size, `larguras divergentes entre listas: ${larguras.join(' · ')}`).toBe(1);
  });
});
