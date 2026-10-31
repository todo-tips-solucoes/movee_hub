#!/usr/bin/env python3
"""Gera o manual compartilhavel do hub (HTML) a partir do JSON versionado.

  FONTE  app_homologacao/frontend_v2/lib/hub/ajuda-conteudo.json
  SAIDA  docs/manuais/hub/manual-movee.html

Mesmo papel do `docs/manuais/app-motorista/gerar.py`, para a OUTRA central de ajuda.
Escrito em 2026-10-31 porque o hub nao tinha gerador: o fluxo dele foi o inverso (o JSON
foi extraido do HTML publicado por jsdom), e sem gerador o HTML compartilhavel ficava para
tras a cada commit de ajuda. Em 31/10 ele estava 6 commits atras e AFIRMAVA que o papel
`financeiro` nao fecha apuracao — falso desde a migration 0115 (19/10).

⚠️ O HTML e SAIDA. Mexer no texto e mexer no JSON, nunca aqui nem no HTML publicado.

O renderizador segue o contrato TIPADO de `frontend_v2/lib/hub/ajuda.ts` (Bloco/Secao/
Conteudo) e a MESMA marcacao inline do parser da tela (`INLINE`, ajuda.ts:53), para que o
HTML e a tela nunca divirjam. Bloco novo no JSON sem suporte aqui ABORTA — herdado da
licao do teste da central, que quebra quando o JSON ganha bloco que a tela nao renderiza.

CSS e JS vem do HTML que ja estava publicado (aprovado em 12/10): este gerador reproduz
aquele visual, nao redesenha.
"""
import json, html, pathlib, re, sys

RAIZ  = pathlib.Path('/var/lib/envioMassa_homologacao')
FONTE = RAIZ / 'app_homologacao/frontend_v2/lib/hub/ajuda-conteudo.json'
SAIDA = RAIZ / 'docs/manuais/hub/manual-movee.html'

# Rotulo do aviso: igual a ROTULO_AVISO de ajuda.ts:13 — o tipo nao pode depender so de cor.
ROTULO = {'importante': 'Importante', 'atencao': 'Atencao', 'dica': 'Dica'}
# Classe da caixa: `importante` e o mais forte, `atencao` o intermediario, `dica` o neutro.
CLASSE = {'importante': 'note danger', 'atencao': 'note warn', 'dica': 'note'}

# Mesma regex do parser da tela (ajuda.ts:53): **forte**, *enfase*, `codigo`, [texto](#id).
INLINE = re.compile(r'\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(#([^)]+)\)')


def inline(texto):
    """Converte a marcacao inline do JSON em HTML, escapando todo o resto."""
    out, pos = [], 0
    for m in INLINE.finditer(texto):
        out.append(html.escape(texto[pos:m.start()]))
        if m[1] is not None:   out.append(f'<strong>{html.escape(m[1])}</strong>')
        elif m[2] is not None: out.append(f'<em>{html.escape(m[2])}</em>')
        elif m[3] is not None: out.append(f'<code>{html.escape(m[3])}</code>')
        else:                  out.append(f'<a href="#{html.escape(m[5])}">{html.escape(m[4])}</a>')
        pos = m.end()
    out.append(html.escape(texto[pos:]))
    return ''.join(out)


def paragrafos(texto):
    """`\n\n` no JSON separa paragrafos — igual ao componente Paragrafos da tela."""
    return ''.join(f'<p>{inline(p.strip())}</p>' for p in texto.split('\n\n') if p.strip())


def b_texto(b):
    cls = ' class="lede"' if b.get('destaque') else ''
    return f'<p{cls}>{inline(b["texto"])}</p>'

def b_subtitulo(b):
    return f'<h3>{inline(b["texto"])}</h3>'

def b_lista(b):
    itens = ''.join(f'<li>{inline(i)}</li>' for i in b['itens'])
    return f'<ul>{itens}</ul>'

def b_passos(b):
    itens = ''.join(f'<li>{inline(i)}</li>' for i in b['itens'])
    return f'<ol class="steps">{itens}</ol>'

def b_tabela(b):
    cab = ''.join(f'<th>{inline(c)}</th>' for c in b['cabecalho'])
    linhas = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in l) + '</tr>' for l in b['linhas'])
    return (f'<div class="tw"><table><thead><tr>{cab}</tr></thead>'
            f'<tbody>{linhas}</tbody></table></div>')

def b_aviso(b):
    tipo = b['tipo']
    if tipo not in CLASSE:
        sys.exit(f'ERRO: tipo de aviso desconhecido: {tipo!r}. Atualize CLASSE/ROTULO.')
    partes = [f'<span class="tag">{ROTULO[tipo]}</span>']
    if b.get('titulo'):
        partes.append(f'<p><strong>{inline(b["titulo"])}</strong></p>')
    if b.get('texto'):
        partes.append(paragrafos(b['texto']))
    if b.get('itens'):
        partes.append(''.join(f'<li>{inline(i)}</li>' for i in b['itens']).join(('<ul>', '</ul>')))
    return f'<div class="{CLASSE[tipo]}">' + ''.join(partes) + '</div>'

def b_trilha(b):
    sts = []
    for i, p in enumerate(b['passos'], 1):
        sts.append(f'<div class="st"><div class="dot">{i}</div><div>'
                   f'<b>{inline(p["titulo"])}</b>'
                   f'<span class="by">{inline(p["quem"])}</span>'
                   f'{paragrafos(p["texto"])}</div></div>')
    return '<div class="flow">' + ''.join(sts) + '</div>'


RENDER = {'texto': b_texto, 'subtitulo': b_subtitulo, 'lista': b_lista, 'passos': b_passos,
          'tabela': b_tabela, 'aviso': b_aviso, 'trilha': b_trilha}


def bloco(b):
    nome = b.get('bloco')
    if nome not in RENDER:
        # Fail-closed de proposito: bloco novo no JSON sem suporte aqui sairia INVISIVEL
        # no manual compartilhavel, e ninguem notaria. Melhor abortar.
        sys.exit(f'ERRO: bloco {nome!r} nao tem renderizador. Veja o contrato em '
                 f'frontend_v2/lib/hub/ajuda.ts e acrescente em RENDER.')
    return RENDER[nome](b)


def main():
    d = json.loads(FONTE.read_text(encoding='utf-8'))
    secoes = d['secoes']

    # Indice agrupado por `grupo`, preservando a ordem de aparicao das secoes.
    grupos, ordem = {}, []
    for n, s in enumerate(secoes, 1):
        g = s['grupo']
        if g not in grupos:
            grupos[g] = []
            ordem.append(g)
        grupos[g].append((n, s))

    toc = []
    for g in ordem:
        itens = ''.join(f'<li><a href="#{s["id"]}">{n} · {html.escape(s["titulo"])}</a></li>'
                        for n, s in grupos[g])
        toc.append(f'<h2>{html.escape(g)}</h2><ol>{itens}</ol>')

    corpo, grupo_atual = [], None
    for n, s in enumerate(secoes, 1):
        if s['grupo'] != grupo_atual and grupo_atual is not None:
            corpo.append('<hr>')
        grupo_atual = s['grupo']
        corpo.append(f'<h2 id="{s["id"]}"><span class="n">{n}</span>{html.escape(s["titulo"])}</h2>')
        corpo.extend(bloco(b) for b in s['blocos'])

    data = d['atualizadoEm']
    data_br = '/'.join(reversed(data.split('-'))) if '-' in data else data

    pagina = f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Manual Movee</title>
<meta name="description" content="{html.escape(d['subtitulo'][:160])}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap">
<style>
__CSS__
</style></head><body>
<button class="theme" id="themeBtn" type="button">tema</button>
<div class="wrap">
<nav class="toc" aria-label="Indice">
{{toc}}
</nav>
<main>
<header class="top">
  <p class="kicker">Manual de uso</p>
  <h1>Movee: painel, hub e app do motorista</h1>
  <p class="sub">{{sub}}</p>
  <div class="meta">
    <span class="pill b">Atualizado em {{data_br}}</span>
    <span class="pill">3 sistemas</span>
    <span class="pill">app.moveelog.com.br</span>
  </div>
</header>
{{corpo}}
<hr>
<p class="lede">Gerado de <code>frontend_v2/lib/hub/ajuda-conteudo.json</code> por
<code>docs/manuais/hub/gerar.py</code> — a mesma fonte da Central de Ajuda do hub, para que
as duas versoes nunca divirjam. Para mudar o texto, mude o JSON e rode o gerador.</p>
</main>
</div>
<script>
__JS__
</script>
</body></html>
"""
    pagina = (pagina
              .replace('__CSS__', CSS)
              .replace('__JS__', JS)
              .replace('{toc}', '\n'.join(toc))
              .replace('{sub}', inline(d['subtitulo']))
              .replace('{data_br}', data_br)
              .replace('{corpo}', '\n'.join(corpo)))

    SAIDA.parent.mkdir(parents=True, exist_ok=True)
    SAIDA.write_text(pagina, encoding='utf-8')
    tipos = sorted({b.get('bloco') for s in secoes for b in s['blocos']})
    print(f'HTML: {SAIDA}  ({len(pagina)/1024:.1f} KB)')
    print(f'secoes: {len(secoes)} em {len(ordem)} grupos | tipos de bloco: {", ".join(tipos)}')


CSS = """/* Layout: índice fixo à esquerda + coluna de leitura de ~68ch; em telas estreitas o índice vira uma lista recolhível no topo. */
:root{
  --bg:#f9f2e8; --surface:#fffdfa; --surface-2:#efe6d6;
  --fg:#0f1849; --fg-soft:#52618a; --line:#e0d4bf;
  --brand:#2c66e9; --brand-soft:#e7eefc; --accent:#0f4938; --accent-bg:#b4ffed;
  --warn:#8a4b00; --warn-bg:#fdf0d8; --danger:#9b1c2e; --danger-bg:#fbe9eb; --ok:#0f5d3f; --ok-bg:#e2f6ec;
  --font:"Plus Jakarta Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --r:10px; --shadow:0 1px 2px rgba(15,24,73,.06),0 8px 24px -16px rgba(15,24,73,.18);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0a1130; --surface:#101a3f; --surface-2:#18234d;
  --fg:#e9eefb; --fg-soft:#9fb0d8; --line:#263264;
  --brand:#5b8df2; --brand-soft:#17254f; --accent:#b4ffed; --accent-bg:#113a2e;
  --warn:#ffcf8a; --warn-bg:#3a2a0f; --danger:#ffb3bd; --danger-bg:#3d1620; --ok:#9fe8c4; --ok-bg:#0e3626;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -16px rgba(0,0,0,.6); color-scheme:dark;
}}
:root[data-theme="dark"]{
  --bg:#0a1130; --surface:#101a3f; --surface-2:#18234d;
  --fg:#e9eefb; --fg-soft:#9fb0d8; --line:#263264;
  --brand:#5b8df2; --brand-soft:#17254f; --accent:#b4ffed; --accent-bg:#113a2e;
  --warn:#ffcf8a; --warn-bg:#3a2a0f; --danger:#ffb3bd; --danger-bg:#3d1620; --ok:#9fe8c4; --ok-bg:#0e3626;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -16px rgba(0,0,0,.6); color-scheme:dark;
}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font-family:var(--font);font-size:15.5px;line-height:1.62;margin:0}
.wrap{display:grid;grid-template-columns:260px minmax(0,1fr);gap:40px;max-width:1180px;margin:0 auto;padding:0 16px;padding-block:0 64px}
@media (max-width:900px){.wrap{grid-template-columns:minmax(0,1fr);gap:0}}

/* ---- índice ---- */
.toc{position:sticky;top:calc(env(safe-area-inset-top,0px) + 16px);align-self:start;max-height:calc(100vh - 48px);overflow-y:auto;padding:20px 0;font-size:13.5px}
@media (max-width:900px){.toc{position:static;max-height:none;border-bottom:1px solid var(--line);margin-bottom:8px}}
.toc h2{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--fg-soft);margin:0 0 10px;font-weight:700}
.toc ol{list-style:none;margin:0 0 20px;padding:0;display:flex;flex-direction:column;gap:2px}
.toc a{color:var(--fg-soft);text-decoration:none;display:block;padding:4px 10px;border-radius:7px;border-left:2px solid transparent}
.toc a:hover{color:var(--fg);background:var(--surface-2)}
.toc a.lead{color:var(--fg);font-weight:600}
.toc details summary{cursor:pointer;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--fg-soft);font-weight:700;padding:8px 0}

/* ---- tipografia ---- */
main{padding-block:28px 0;min-width:0}
h1{font-size:clamp(1.9rem,4.6vw,2.6rem);line-height:1.1;letter-spacing:-.022em;margin:0 0 10px;font-weight:800;text-wrap:balance}
.sub{font-size:1.06rem;color:var(--fg-soft);max-width:62ch;margin:0 0 28px}
h2{font-size:1.46rem;letter-spacing:-.016em;margin:56px 0 4px;font-weight:750;text-wrap:balance;scroll-margin-top:24px}
h2 .n{color:var(--brand);font-variant-numeric:tabular-nums;margin-right:.5rem;font-weight:700}
h3{font-size:1.1rem;margin:32px 0 6px;font-weight:700;text-wrap:balance;scroll-margin-top:24px}
h4{font-size:.95rem;margin:22px 0 4px;font-weight:700}
p,ul,ol{max-width:70ch}
p{margin:.65rem 0}
ul,ol{margin:.6rem 0;padding-left:1.3rem}
li{margin:.3rem 0}
a{color:var(--brand)}
code{font-family:var(--mono);font-size:.86em;background:var(--surface-2);padding:.12em .36em;border-radius:5px;overflow-wrap:anywhere}
strong{font-weight:700}
hr{border:0;border-top:1px solid var(--line);margin:48px 0}
.lede{font-size:1rem;color:var(--fg-soft);max-width:70ch;margin:.3rem 0 1.2rem}

/* ---- blocos ---- */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;margin:18px 0;box-shadow:var(--shadow)}
.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}
.note{border-left:3px solid var(--brand);background:var(--brand-soft);border-radius:0 var(--r) var(--r) 0;padding:14px 18px;margin:18px 0}
.note.warn{border-left-color:var(--warn);background:var(--warn-bg)}
.note.danger{border-left-color:var(--danger);background:var(--danger-bg)}
.note.ok{border-left-color:var(--ok);background:var(--ok-bg)}
.note>:first-child{margin-top:0}.note>:last-child{margin-bottom:0}
.note .tag{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;margin-bottom:4px}
.note .tag{color:var(--brand)} .note.warn .tag{color:var(--warn)} .note.danger .tag{color:var(--danger)} .note.ok .tag{color:var(--ok)}

/* ---- passos numerados: só onde a ordem é informação ---- */
ol.steps{list-style:none;padding:0;counter-reset:s;max-width:70ch}
ol.steps>li{counter-increment:s;position:relative;padding-left:40px;margin:14px 0}
ol.steps>li::before{content:counter(s);position:absolute;left:0;top:1px;width:26px;height:26px;border-radius:50%;background:var(--brand);color:#fff;font-size:13px;font-weight:700;display:grid;place-items:center;font-variant-numeric:tabular-nums}
:root[data-theme="dark"] ol.steps>li::before{color:#0a1130}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) ol.steps>li::before{color:#0a1130}}

/* ---- tabelas ---- */
.tw{overflow-x:auto;margin:18px 0;border:1px solid var(--line);border-radius:var(--r);background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:460px}
th,td{text-align:left;padding:9px 13px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--surface-2);font-weight:700;font-size:12.5px;letter-spacing:.02em;white-space:nowrap}
tr:last-child td{border-bottom:0}
td code{background:transparent;padding:0;color:var(--fg-soft);font-size:.84em}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.yes{color:var(--ok);font-weight:700}.no{color:var(--danger);font-weight:700}

/* ---- pílulas de estado ---- */
.pill{display:inline-block;font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:999px;border:1px solid var(--line);background:var(--surface-2);white-space:nowrap}
.pill.b{background:var(--brand-soft);border-color:var(--brand);color:var(--brand)}
.pill.g{background:var(--ok-bg);border-color:var(--ok);color:var(--ok)}
.pill.y{background:var(--warn-bg);border-color:var(--warn);color:var(--warn)}
.pill.r{background:var(--danger-bg);border-color:var(--danger);color:var(--danger)}

/* ---- trilha do ciclo ---- */
.flow{display:flex;flex-direction:column;gap:0;margin:22px 0;max-width:70ch}
.flow .st{display:grid;grid-template-columns:34px minmax(0,1fr);gap:14px;padding:0 0 18px;position:relative}
.flow .st:not(:last-child)::before{content:"";position:absolute;left:16px;top:34px;bottom:0;width:2px;background:var(--line)}
.flow .dot{width:34px;height:34px;border-radius:50%;background:var(--surface);border:2px solid var(--brand);color:var(--brand);display:grid;place-items:center;font-weight:800;font-size:14px;z-index:1;font-variant-numeric:tabular-nums}
.flow .st.who-m .dot{border-color:var(--accent);color:var(--accent)}
.flow .st.pay .dot{background:var(--brand);color:#fff;border-color:var(--brand)}
:root[data-theme="dark"] .flow .st.pay .dot{color:#0a1130}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .flow .st.pay .dot{color:#0a1130}}
.flow b{display:block;font-size:1rem}
.flow .by{font-size:12px;color:var(--fg-soft);font-weight:600;letter-spacing:.02em}
.flow p{margin:.25rem 0 0;font-size:14.5px}

/* ---- topo ---- */
header.top{padding-block:40px 0}
.kicker{font-size:12px;letter-spacing:.11em;text-transform:uppercase;color:var(--brand);font-weight:800;margin:0 0 10px}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px}
.theme{position:fixed;top:calc(env(safe-area-inset-top,0px) + 10px);right:12px;z-index:9;background:var(--surface);color:var(--fg-soft);border:1px solid var(--line);border-radius:999px;padding:6px 13px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;box-shadow:var(--shadow)}
.theme:hover{color:var(--fg)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:4px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}"""

JS = """(function(){
  var b=document.getElementById('themeBtn');
  function cur(){var a=document.documentElement.getAttribute('data-theme');if(a)return a;
    return window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}
  function label(){b.textContent=cur()==='dark'?'tema claro':'tema escuro';}
  try{var s=localStorage.getItem('manual-tema');if(s==='dark'||s==='light')document.documentElement.setAttribute('data-theme',s);}catch(e){}
  label();
  b.addEventListener('click',function(){var n=cur()==='dark'?'light':'dark';
    document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('manual-tema',n);}catch(e){}label();});
})();"""

if __name__ == '__main__':
    main()
