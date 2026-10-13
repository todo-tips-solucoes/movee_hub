'use client';

// Central de Ajuda do hub — renderiza lib/hub/ajuda-conteudo.json (fonte da
// verdade do texto; nada dele é copiado para cá). Irmã de
// frontend_motorista/app/(app)/ajuda. Não é módulo: qualquer usuário com
// sessão (o HubSessionGuard do layout já barra o resto) lê, sem permissão.
//
// Navegação: são 26 seções, então índice lateral fixo em lg+ (âncoras nativas
// `#id`, sem estado) e, abaixo de lg, o mesmo índice num <details> recolhido.
// Busca: filtra seções por texto (todas as palavras, sem acento).

import { useMemo, useState } from 'react';
import { Info, Lightbulb, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { PageHeader } from '@/components/hub/page-header';
import { LARGURA_HOME } from '@/lib/hub/larguras';
import { cn } from '@/lib/utils';
import {
  conteudo, filtrarSecoes, indice, partirInline, ROTULO_AVISO,
  type Bloco, type Secao, type TipoAviso,
} from '@/lib/hub/ajuda';

const AVISO_ESTILO: Record<TipoAviso, { Icon: LucideIcon; badge: 'default' | 'warning' | 'success'; caixa: string }> = {
  importante: { Icon: Info, badge: 'default', caixa: 'border-primary/40 bg-primary/5' },
  atencao: { Icon: TriangleAlert, badge: 'warning', caixa: 'border-warning/60 bg-warning/10' },
  dica: { Icon: Lightbulb, badge: 'success', caixa: 'border-success/40 bg-success/10' },
};

const SCROLL_MT = 'scroll-mt-[calc(var(--env-badge-h,0px)+5rem)]';

function Inline({ texto }: { texto: string }) {
  return (
    <>
      {partirInline(texto).map((t, i) => {
        if (t.t === 'forte') return <strong key={i} className="font-semibold text-foreground">{t.v}</strong>;
        if (t.t === 'enfase') return <em key={i}>{t.v}</em>;
        if (t.t === 'codigo') return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere]">{t.v}</code>;
        if (t.t === 'link') return <a key={i} href={`#${t.id}`} className="text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">{t.v}</a>;
        return <span key={i}>{t.v}</span>;
      })}
    </>
  );
}

/** Parágrafos separados por linha em branco dentro de um mesmo texto. */
function Paragrafos({ texto }: { texto: string }) {
  return (
    <>
      {texto.split('\n\n').map((p, i) => <p key={i}><Inline texto={p} /></p>)}
    </>
  );
}

function Itens({ itens, ordenada }: { itens: string[]; ordenada?: boolean }) {
  const Tag = ordenada ? 'ol' : 'ul';
  return (
    <Tag className={cn('space-y-1.5 pl-5', ordenada ? 'list-decimal' : 'list-disc')}>
      {itens.map((t, i) => <li key={i} className="pl-1"><Inline texto={t} /></li>)}
    </Tag>
  );
}

function Aviso({ b }: { b: Extract<Bloco, { bloco: 'aviso' }> }) {
  const { Icon, badge, caixa } = AVISO_ESTILO[b.tipo];
  return (
    <div className={cn('space-y-2 rounded-lg border p-4 text-sm leading-relaxed', caixa)}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge}><Icon aria-hidden="true" />{ROTULO_AVISO[b.tipo]}</Badge>
        {b.titulo && <span className="font-semibold text-foreground"><Inline texto={b.titulo} /></span>}
      </div>
      {b.texto && <Paragrafos texto={b.texto} />}
      {b.itens && <Itens itens={b.itens} />}
    </div>
  );
}

function Trilha({ passos }: { passos: Extract<Bloco, { bloco: 'trilha' }>['passos'] }) {
  return (
    <ol className="space-y-3">
      {passos.map((p, i) => (
        <li key={i} className="flex gap-3 rounded-lg border border-border bg-card p-3">
          <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{i + 1}</span>
          <div className="min-w-0 space-y-1 text-sm leading-relaxed">
            <p className="font-semibold text-foreground">{p.titulo}</p>
            <p className="text-xs text-muted-foreground"><Inline texto={p.quem} /></p>
            <Paragrafos texto={p.texto} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Tabela({ cabecalho, linhas }: { cabecalho: string[]; linhas: string[][] }) {
  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>{cabecalho.map((c) => <TableHead key={c} scope="col">{c}</TableHead>)}</TableRow>
        </TableHeader>
        <TableBody>
          {linhas.map((l, i) => (
            <TableRow key={i} className="align-top">
              {l.map((c, j) => <TableCell key={j} className="min-w-32 whitespace-normal"><Inline texto={c} /></TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BlocoAjuda({ b }: { b: Bloco }) {
  switch (b.bloco) {
    case 'texto':
      return <p className={b.destaque ? 'text-base text-foreground' : undefined}><Inline texto={b.texto} /></p>;
    case 'subtitulo':
      return <h3 className="pt-2 font-heading text-base font-semibold text-foreground">{b.texto}</h3>;
    case 'lista':
      return <Itens itens={b.itens} />;
    case 'passos':
      return <Itens itens={b.itens} ordenada />;
    case 'tabela':
      return <Tabela cabecalho={b.cabecalho} linhas={b.linhas} />;
    case 'aviso':
      return <Aviso b={b} />;
    case 'trilha':
      return <Trilha passos={b.passos} />;
  }
}

function SecaoAjuda({ s, numero }: { s: Secao; numero: number }) {
  return (
    <section id={s.id} aria-labelledby={`${s.id}-t`} className={cn('space-y-4 border-t border-border pt-8 leading-relaxed text-foreground/90 first:border-t-0 first:pt-0', SCROLL_MT)}>
      <h2 id={`${s.id}-t`} className="font-heading text-xl font-semibold text-foreground">
        <span className="mr-2 text-muted-foreground tabular-nums">{numero}</span>{s.titulo}
      </h2>
      {s.blocos.map((b, i) => <BlocoAjuda key={i} b={b} />)}
    </section>
  );
}

function Indice({ grupos }: { grupos: ReturnType<typeof indice> }) {
  return (
    <nav aria-label="Índice da Central de Ajuda" className="space-y-4 text-sm">
      {grupos.map((g) => (
        <div key={g.grupo}>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.grupo}</p>
          <ul>
            {g.itens.map((i) => (
              <li key={i.id}>
                <a href={`#${i.id}`} className="flex min-h-9 items-center gap-2 rounded-md px-2 text-foreground/80 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i.numero}</span>
                  <span>{i.titulo}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export default function AjudaPage() {
  const [busca, setBusca] = useState('');
  const { secoes } = conteudo;
  const visiveis = useMemo(() => filtrarSecoes(secoes, busca), [secoes, busca]);
  const grupos = useMemo(() => indice(visiveis, secoes), [visiveis, secoes]);
  const filtrando = busca.trim() !== '';

  return (
    <div className={`mx-auto flex ${LARGURA_HOME} flex-col gap-6 p-4 sm:p-6`}>
      <PageHeader titulo="Central de Ajuda" subtitulo={conteudo.subtitulo} />

      <div className="max-w-xl space-y-1.5">
        <label htmlFor="ajuda-busca" className="text-sm font-medium text-foreground">Buscar no manual</label>
        <Input
          id="ajuda-busca"
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Ex.: lote, Transfeera, nota reprovada"
          autoComplete="off"
        />
        <p role="status" className="text-xs text-muted-foreground">
          {filtrando ? `${visiveis.length} de ${secoes.length} seções` : `${secoes.length} seções`}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
        <aside>
          <details className="rounded-lg border border-border bg-card lg:hidden">
            <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              Índice
            </summary>
            <div className="border-t border-border p-3"><Indice grupos={grupos} /></div>
          </details>
          <div className="sticky top-[calc(var(--env-badge-h,0px)+4.5rem)] hidden max-h-[calc(100svh-6rem)] overflow-y-auto lg:block">
            <Indice grupos={grupos} />
          </div>
        </aside>

        <article className="min-w-0 max-w-[70ch] space-y-8">
          {visiveis.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhuma seção encontrada para &ldquo;{busca}&rdquo;. Tente uma palavra só.</p>
          )}
          {visiveis.map((s) => (
            <SecaoAjuda key={s.id} s={s} numero={secoes.findIndex((x) => x.id === s.id) + 1} />
          ))}
          <p className="border-t border-border pt-4 text-xs text-muted-foreground">
            Atualizado em <time dateTime={conteudo.atualizadoEm}>{conteudo.atualizadoEm.split('-').reverse().join('/')}</time>
          </p>
        </article>
      </div>
    </div>
  );
}
