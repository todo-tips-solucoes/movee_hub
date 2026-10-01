/**
 * Guarda do app instalável: manifest + service worker.
 *
 * Existe porque "Não é possível instalar o app" no Chrome Android não diz qual
 * dos critérios falhou. Os dois erros que mais custam tempo são manifest
 * apontando ícone que não está no disco e SW sem resposta offline — os dois
 * estão cobertos aqui, com os arquivos lidos de verdade.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from './manifest';

describe('manifest do app instalável', () => {
  const m = manifest();

  it('tem os campos que o Chrome exige para instalar', () => {
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBe('/hub');
    expect(m.display).toBe('standalone');
  });

  it('declara ícone de 192 e de 512, e os arquivos existem no disco', () => {
    const tamanhos = (m.icons ?? []).map((i) => i.sizes);
    expect(tamanhos).toContain('192x192');
    expect(tamanhos).toContain('512x512');

    for (const icone of m.icons ?? []) {
      const arquivo = path.join(__dirname, '..', 'public', String(icone.src));
      expect(existsSync(arquivo), `ícone declarado mas ausente: ${icone.src}`).toBe(true);
    }
  });

  it('usa a marca que o produto já mostra na tela, não um terceiro vocabulário', () => {
    // Wordmark do login/header e a aba do painel dizem EntreGô; "Movee" vive no
    // domínio e nos e-mails. Trocar isto é decisão de marca, não refactor.
    expect(m.name).toMatch(/EntreGô/);
  });
});

describe('service worker', () => {
  // Harness mínimo: executa public/sw.js com um `self` falso e dispara o evento.
  function carregarSw() {
    const ouvintes: Record<string, (e: unknown) => void> = {};
    const self = {
      addEventListener: (tipo: string, fn: (e: unknown) => void) => {
        ouvintes[tipo] = fn;
      },
      skipWaiting: () => {},
      clients: { claim: () => Promise.resolve() },
    };
    const codigo = readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    new Function('self', 'fetch', codigo)(self, globalThis.fetch);
    return ouvintes;
  }

  it('registra um fetch handler (sem ele o Chrome não instala)', () => {
    expect(typeof carregarSw().fetch).toBe('function');
  });

  it('responde a navegação quando a rede falha, e não cacheia nada', async () => {
    const ouvintes: Record<string, (e: unknown) => void> = {};
    const self = {
      addEventListener: (t: string, fn: (e: unknown) => void) => {
        ouvintes[t] = fn;
      },
      skipWaiting: () => {},
      clients: { claim: () => Promise.resolve() },
      // se o SW tentasse cachear, cairia aqui
      caches: undefined,
    };
    const codigo = readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    const fetchQueFalha = () => Promise.reject(new Error('offline'));
    new Function('self', 'fetch', codigo)(self, fetchQueFalha);

    let resposta: Response | undefined;
    ouvintes.fetch({
      request: { mode: 'navigate' },
      respondWith: (p: Promise<Response>) => {
        resposta = undefined;
        return p.then((r) => {
          resposta = r;
        });
      },
    } as never);
    await new Promise((r) => setTimeout(r, 0));

    expect(resposta?.status).toBe(503);
    expect(await resposta!.text()).toMatch(/Sem conexão/);
    expect(codigo).not.toMatch(/caches\.(open|match)/); // nunca cachear bundle
  });

  it('deixa passar o que não é navegação (bundle vai direto à rede)', () => {
    const ouvintes = carregarSw();
    let respondeu = false;
    ouvintes.fetch({
      request: { mode: 'cors' },
      respondWith: () => {
        respondeu = true;
      },
    } as never);
    expect(respondeu).toBe(false);
  });
});
