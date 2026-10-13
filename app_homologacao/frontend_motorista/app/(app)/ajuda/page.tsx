'use client';

/**
 * Tela de Ajuda — renderiza lib/ajuda-conteudo.json (fonte da verdade do texto;
 * nada dele é copiado para cá). Navegação: uma seção recolhível por tema
 * (<details>, o mesmo padrão do extrato em /repasse); "pode / não pode" fica
 * sempre aberto no topo. `/ajuda#conta` abre a seção correspondente.
 * Imagens: public/ajuda/img/<arquivo>; se faltar, a seção segue só com o texto.
 */

import { useEffect, useRef, useState } from 'react';
import { BottomNav } from '@/components/bottom-nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import {
  AlertCircle, AlertTriangle, Block, CheckCircle, ExpandMore, Lightbulb,
} from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { imagemQuebrada, imagemSrc, ROTULO_AVISO, secaoDoHash, type TipoAviso } from '@/lib/ajuda';
import conteudoJson from '@/lib/ajuda-conteudo.json';

type Aviso = { tipo: TipoAviso; texto: string };
type Tabela = { titulo?: string; cabecalho: string[]; linhas: string[][] };
type Lista = { titulo: string; itens?: string[]; passos?: string[]; nota?: string };
type Resultado = { tipo: string; titulo: string; img: string; imgAlt: string; texto: string };
type Secao = {
  id: string; titulo: string; intro: string;
  img?: string; imgAlt?: string; img2?: string; img2Alt?: string;
  passos?: string[]; avisos?: Aviso[];
  tabela?: Tabela; errosCampos?: Tabela; motivos?: Tabela;
  regras?: Lista; requisitos?: Lista; primeiraVez?: Lista; esqueciSenha?: Lista;
  resultados?: Resultado[];
  extra?: { titulo: string; img: string; imgAlt: string; texto: string; statusNota: string[][] };
};
type Conteudo = {
  titulo: string; subtitulo: string; atualizadoEm: string;
  podeNaoPode: { titulo: string; nota: string; pode: string[]; naoPode: { o: string; porque: string; saida: string }[] };
  secoes: Secao[];
  problemas: { titulo: string; intro: string; grupos: { grupo: string; itens: string[][] }[] };
  rodape: string;
};

const conteudo = conteudoJson as Conteudo;
const IDS = [...conteudo.secoes.map((s) => s.id), 'problemas'];

const AVISO_ESTILO = {
  importante: { Icon: AlertCircle, badge: 'info', caixa: 'border-primary/40 bg-primary/5' },
  atencao: { Icon: AlertTriangle, badge: 'warning', caixa: 'border-warning/60 bg-warning/10' },
  dica: { Icon: Lightbulb, badge: 'success', caixa: 'border-success/40 bg-success/10' },
} as const;

function Imagem({ arquivo, alt }: { arquivo: string; alt: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [falhou, setFalhou] = useState(false);

  // onError não dispara se a falha ocorreu antes da hidratação.
  useEffect(() => {
    if (ref.current && imagemQuebrada(ref.current)) setFalhou(true);
  }, []);

  if (falhou) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={imagemSrc(arquivo)}
      alt={alt}
      loading="lazy"
      onError={() => setFalhou(true)}
      className="mx-auto h-auto max-w-full rounded-xl border border-border"
    />
  );
}

function Passos({ passos }: { passos: string[] }) {
  return (
    <ol className="space-y-2 text-sm leading-relaxed">
      {passos.map((p, i) => (
        <li key={i} className="flex gap-3">
          <span className="tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-bold" aria-hidden="true">{i + 1}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{p}</span>
        </li>
      ))}
    </ol>
  );
}

function Avisos({ avisos }: { avisos: Aviso[] }) {
  return (
    <div className="space-y-2.5">
      {avisos.map((a, i) => {
        const { Icon, badge, caixa } = AVISO_ESTILO[a.tipo];
        return (
          <div key={i} className={cn('space-y-1.5 rounded-xl border p-3 text-sm leading-relaxed', caixa)}>
            <Badge variant={badge}><Icon className="h-4 w-4" />{ROTULO_AVISO[a.tipo]}</Badge>
            <p>{a.texto}</p>
          </div>
        );
      })}
    </div>
  );
}

function Tabela({ titulo, cabecalho, linhas }: Tabela) {
  return (
    <div className="space-y-2">
      {titulo && <h3 className="font-display text-sm">{titulo}</h3>}
      <table className="w-full table-fixed border-collapse overflow-hidden rounded-xl text-left text-sm">
        <thead>
          <tr className="bg-muted">
            {cabecalho.map((c) => <th key={c} scope="col" className="p-2.5 text-xs font-semibold">{c}</th>)}
          </tr>
        </thead>
        <tbody className="[&_td]:[overflow-wrap:anywhere]">
          {linhas.map((l, i) => (
            <tr key={i} className="border-t border-border align-top">
              <th scope="row" className="p-2.5 font-medium">{l[0]}</th>
              <td className="p-2.5 text-muted-foreground">{l[1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListaTitulada({ titulo, itens, passos, nota }: Lista) {
  return (
    <div className="space-y-2 rounded-xl bg-muted/60 p-3">
      <h3 className="font-display text-sm">{titulo}</h3>
      {passos && <Passos passos={passos} />}
      {itens && (
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
          {itens.map((t) => <li key={t}>{t}</li>)}
        </ul>
      )}
      {nota && <p className="text-xs leading-relaxed text-muted-foreground">{nota}</p>}
    </div>
  );
}

function Recolhivel({ id, titulo, children }: { id: string; titulo: string; children: React.ReactNode }) {
  return (
    <details id={id} className="group scroll-mt-20 overflow-hidden rounded-2xl border border-border bg-card">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <h2 className="font-display text-base">{titulo}</h2>
        <ExpandMore className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-4">{children}</div>
    </details>
  );
}

function SecaoAjuda({ s }: { s: Secao }) {
  return (
    <Recolhivel id={s.id} titulo={s.titulo}>
      <p className="text-sm leading-relaxed">{s.intro}</p>
      {s.img && <Imagem arquivo={s.img} alt={s.imgAlt ?? ''} />}
      {s.regras && <ListaTitulada {...s.regras} />}
      {s.requisitos && <ListaTitulada {...s.requisitos} />}
      {s.passos && <Passos passos={s.passos} />}
      {s.primeiraVez && <ListaTitulada {...s.primeiraVez} />}
      {s.esqueciSenha && <ListaTitulada {...s.esqueciSenha} />}
      {s.tabela && <Tabela {...s.tabela} />}
      {s.resultados?.map((r) => (
        <div key={r.titulo} className="space-y-2">
          <h3 className="flex items-center gap-2 font-display text-sm">
            {r.tipo === 'ok'
              ? <CheckCircle className="h-5 w-5 text-success" />
              : <Block className="h-5 w-5 text-destructive" />}
            {r.titulo}
          </h3>
          <Imagem arquivo={r.img} alt={r.imgAlt} />
          <p className="text-sm leading-relaxed">{r.texto}</p>
        </div>
      ))}
      {s.errosCampos && <Tabela {...s.errosCampos} />}
      {s.img2 && <Imagem arquivo={s.img2} alt={s.img2Alt ?? ''} />}
      {s.avisos && <Avisos avisos={s.avisos} />}
      {s.extra && (
        <div className="space-y-2">
          <h3 className="font-display text-sm">{s.extra.titulo}</h3>
          <Imagem arquivo={s.extra.img} alt={s.extra.imgAlt} />
          <p className="text-sm leading-relaxed">{s.extra.texto}</p>
          <Tabela cabecalho={['Status', 'O que significa']} linhas={s.extra.statusNota} />
        </div>
      )}
      {s.motivos && <Tabela {...s.motivos} />}
    </Recolhivel>
  );
}

export default function AjudaPage() {
  // Deep link: /ajuda#conta abre e rola até a seção (só ids conhecidos).
  useEffect(() => {
    const abrir = () => {
      const id = secaoDoHash(window.location.hash, IDS);
      const el = id && document.getElementById(id);
      if (el instanceof HTMLDetailsElement) {
        el.open = true;
        el.scrollIntoView();
      }
    };
    abrir();
    window.addEventListener('hashchange', abrir);
    return () => window.removeEventListener('hashchange', abrir);
  }, []);

  const { podeNaoPode: pnp, problemas } = conteudo;

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <span className="font-display text-lg font-bold">Ajuda</span>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-4 px-4 pb-24 pt-5">
        <div className="space-y-1">
          <h1 className="font-display text-2xl">{conteudo.titulo}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{conteudo.subtitulo}</p>
        </div>

        <section aria-labelledby="pode-nao-pode" className="space-y-4 rounded-2xl border border-border bg-card p-4">
          <div className="space-y-1">
            <h2 id="pode-nao-pode" className="font-display text-lg">{pnp.titulo}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{pnp.nota}</p>
          </div>
          <h3 className="font-display text-sm">O que você pode fazer</h3>
          <ul className="space-y-2.5 text-sm leading-relaxed">
            {pnp.pode.map((t) => (
              <li key={t} className="flex gap-2.5">
                <CheckCircle className="mt-0.5 h-5 w-5 text-success" />
                <span className="min-w-0">{t}</span>
              </li>
            ))}
          </ul>
          <h3 className="font-display text-sm">O que o app não aceita</h3>
          <ul className="space-y-3">
            {pnp.naoPode.map((n) => (
              <li key={n.o} className="space-y-1 rounded-xl bg-muted/60 p-3 text-sm leading-relaxed">
                <p className="flex gap-2.5 font-semibold">
                  <Block className="mt-0.5 h-5 w-5 text-destructive" />
                  <span className="min-w-0">{n.o}</span>
                </p>
                <p className="text-muted-foreground">{n.porque}</p>
                <p><strong>O que fazer:</strong> {n.saida}</p>
              </li>
            ))}
          </ul>
        </section>

        {conteudo.secoes.map((s) => <SecaoAjuda key={s.id} s={s} />)}

        <Recolhivel id="problemas" titulo={problemas.titulo}>
          <p className="text-sm leading-relaxed">{problemas.intro}</p>
          {problemas.grupos.map((g) => (
            <div key={g.grupo} className="space-y-2">
              <h3 className="font-display text-sm">{g.grupo}</h3>
              <dl className="space-y-2">
                {g.itens.map(([msg, fazer]) => (
                  <div key={msg} className="rounded-xl bg-muted/60 p-3 text-sm leading-relaxed">
                    <dt className="font-semibold [overflow-wrap:anywhere]">{msg}</dt>
                    <dd className="text-muted-foreground">{fazer}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </Recolhivel>

        <footer className="space-y-1 px-1 text-xs leading-relaxed text-muted-foreground">
          <p>{conteudo.rodape}</p>
          <p>Atualizado em <time dateTime={conteudo.atualizadoEm}>{conteudo.atualizadoEm.split('-').reverse().join('/')}</time></p>
        </footer>
      </div>

      <BottomNav />
    </main>
  );
}
