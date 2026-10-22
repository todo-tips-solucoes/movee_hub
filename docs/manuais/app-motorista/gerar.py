#!/usr/bin/env python3
"""Gera o HTML do Guia do App do Motorista a partir da MESMA fonte que a tela /ajuda do app usa."""
import json, html, pathlib, sys

FONTE = pathlib.Path('/var/lib/envioMassa_homologacao/app_homologacao/frontend_motorista/lib/ajuda-conteudo.json')
IMGDIR = pathlib.Path('/var/lib/envioMassa_homologacao/docs/manuais/app-motorista/img')
SAIDA = pathlib.Path('/var/lib/envioMassa_homologacao/docs/manuais/app-motorista/guia-motorista.html')

d = json.loads(FONTE.read_text(encoding='utf-8'))
e = lambda s: html.escape(str(s), quote=True)
existentes = {p.name for p in IMGDIR.glob('*.png')} if IMGDIR.exists() else set()
usadas = []

def fig(nome, alt, legenda=None):
    """Figura só se o print existe — nada de imagem quebrada no material distribuído."""
    if not nome or nome not in existentes:
        return ''
    usadas.append(nome)
    cap = f'<figcaption>{e(legenda)}</figcaption>' if legenda else ''
    return (f'<figure class="shot"><div class="phone"><img src="img/{e(nome)}" alt="{e(alt or "")}" '
            f'loading="lazy" width="390" height="844"></div>{cap}</figure>')

def avisos(lista):
    if not lista: return ''
    rot = {'importante': 'Importante', 'atencao': 'Atenção', 'dica': 'Dica'}
    out = []
    for a in lista:
        tipo = a.get('tipo', 'dica')
        out.append(f'<div class="note {e(tipo)}"><span class="tag">{e(rot.get(tipo, tipo))}</span>'
                   f'<p>{e(a.get("texto",""))}</p></div>')
    return '\n'.join(out)

def passos(lista):
    if not lista: return ''
    its = '\n'.join(f'<li>{e(x)}</li>' for x in lista)
    return f'<ol class="steps">{its}</ol>'

def tabela(cab, linhas, classe=''):
    if not linhas: return ''
    th = ''.join(f'<th>{e(c)}</th>' for c in (cab or []))
    head = f'<thead><tr>{th}</tr></thead>' if cab else ''
    body = ''.join('<tr>' + ''.join(f'<td>{e(c)}</td>' for c in ln) + '</tr>' for ln in linhas)
    return f'<div class="tw"><table class="{classe}">{head}<tbody>{body}</tbody></table></div>'

# ── bloco pode / não pode ────────────────────────────────────────────────────
pnp = d['podeNaoPode']
pode_li = '\n'.join(f'<li>{e(x)}</li>' for x in pnp['pode'])
nao_cards = '\n'.join(
    f'<div class="np"><h4>{e(x["o"])}</h4><p class="porque">{e(x["porque"])}</p>'
    f'<p class="saida"><strong>O que fazer:</strong> {e(x["saida"])}</p></div>'
    for x in pnp['naoPode'])

# ── seções ───────────────────────────────────────────────────────────────────
secs, toc = [], []
for i, s in enumerate(d['secoes'], 1):
    toc.append(f'<li><a href="#{e(s["id"])}">{i} · {e(s["titulo"])}</a></li>')
    p = [f'<h2 id="{e(s["id"])}"><span class="n">{i}</span>{e(s["titulo"])}</h2>']
    if s.get('intro'): p.append(f'<p class="lede">{e(s["intro"])}</p>')
    p.append(fig(s.get('img'), s.get('imgAlt')))
    p.append(passos(s.get('passos')))

    if s.get('tabela'):
        p.append(tabela(s['tabela'].get('cabecalho'), s['tabela'].get('linhas')))

    for chave, titulo_pad in (('primeiraVez', None), ('esqueciSenha', None)):
        b = s.get(chave)
        if b:
            p.append(f'<h3>{e(b.get("titulo", titulo_pad or chave))}</h3>')
            p.append(passos(b.get('passos')))
            if b.get('nota'): p.append(f'<div class="note dica"><span class="tag">Dica</span><p>{e(b["nota"])}</p></div>')

    for chave in ('regras', 'requisitos'):
        b = s.get(chave)
        if b:
            its = '\n'.join(f'<li>{e(x)}</li>' for x in b.get('itens', []))
            p.append(f'<div class="card"><h4>{e(b.get("titulo",""))}</h4><ul class="checks">{its}</ul>')
            if b.get('nota'): p.append(f'<p class="nota-min">{e(b["nota"])}</p>')
            p.append('</div>')

    for r in s.get('resultados', []):
        cls = 'ok' if r.get('tipo') == 'ok' else 'erro'
        p.append(f'<div class="res {cls}"><h4>{e(r.get("titulo",""))}</h4><p>{e(r.get("texto",""))}</p>'
                 f'{fig(r.get("img"), r.get("imgAlt"))}</div>')

    if s.get('errosCampos'):
        ec = s['errosCampos']
        p.append(f'<h3>{e(ec.get("titulo",""))}</h3>')
        p.append(tabela(ec.get('cabecalho'), ec.get('linhas')))

    if s.get('extra'):
        x = s['extra']
        p.append(f'<h3>{e(x.get("titulo",""))}</h3>')
        if x.get('texto'): p.append(f'<p>{e(x["texto"])}</p>')
        p.append(fig(x.get('img'), x.get('imgAlt')))
        if x.get('statusNota'):
            p.append(tabela(['Status', 'O que significa'], x['statusNota']))

    if s.get('motivos'):
        m = s['motivos']
        p.append(f'<h3>{e(m.get("titulo",""))}</h3>')
        p.append(tabela(m.get('cabecalho'), m.get('linhas')))

    p.append(fig(s.get('img2'), s.get('img2Alt')))
    p.append(avisos(s.get('avisos')))
    secs.append('\n'.join(x for x in p if x))

# ── problemas ────────────────────────────────────────────────────────────────
pb = d['problemas']
grupos = '\n'.join(
    f'<h3>{e(g["grupo"])}</h3>' + tabela(['Se aparecer', 'O que fazer'], g['itens'])
    for g in pb['grupos'])

ano, mes, dia = d['atualizadoEm'].split('-')
data_br = f'{dia}/{mes}/{ano}'

# ── página ───────────────────────────────────────────────────────────────────
CSS = """
/* Layout: coluna de leitura única com os prints em molduras de celular à direita quando há espaço. */
:root{
  --bg:#f9f2e8; --surface:#fffdfa; --surface-2:#efe6d6;
  --fg:#0f1849; --fg-soft:#52618a; --line:#e0d4bf;
  --brand:#2c66e9; --brand-soft:#e7eefc;
  --ok:#0f5d3f; --ok-bg:#e2f6ec; --warn:#8a4b00; --warn-bg:#fdf0d8;
  --no:#9b1c2e; --no-bg:#fbe9eb; --phone:#0f1849;
  --font:"Plus Jakarta Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --r:12px; --shadow:0 1px 2px rgba(15,24,73,.06),0 10px 30px -18px rgba(15,24,73,.25);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0a1130; --surface:#101a3f; --surface-2:#18234d; --fg:#e9eefb; --fg-soft:#9fb0d8; --line:#263264;
  --brand:#5b8df2; --brand-soft:#17254f; --ok:#9fe8c4; --ok-bg:#0e3626; --warn:#ffcf8a; --warn-bg:#3a2a0f;
  --no:#ffb3bd; --no-bg:#3d1620; --phone:#000; color-scheme:dark;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -18px rgba(0,0,0,.7);
}}
:root[data-theme="dark"]{
  --bg:#0a1130; --surface:#101a3f; --surface-2:#18234d; --fg:#e9eefb; --fg-soft:#9fb0d8; --line:#263264;
  --brand:#5b8df2; --brand-soft:#17254f; --ok:#9fe8c4; --ok-bg:#0e3626; --warn:#ffcf8a; --warn-bg:#3a2a0f;
  --no:#ffb3bd; --no-bg:#3d1620; --phone:#000; color-scheme:dark;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -18px rgba(0,0,0,.7);
}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font-family:var(--font);font-size:16px;line-height:1.65;margin:0}
.wrap{max-width:820px;margin:0 auto;padding:0 16px;padding-block:0 72px}
h1{font-size:clamp(2rem,5.2vw,2.8rem);line-height:1.08;letter-spacing:-.025em;margin:0 0 12px;font-weight:800;text-wrap:balance}
.sub{font-size:1.1rem;color:var(--fg-soft);max-width:60ch;margin:0 0 24px}
h2{font-size:1.52rem;letter-spacing:-.018em;margin:64px 0 6px;font-weight:750;text-wrap:balance;scroll-margin-top:20px}
h2 .n{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--brand);color:#fff;font-size:1rem;font-weight:700;margin-right:.6rem;vertical-align:3px}
:root[data-theme="dark"] h2 .n{color:#0a1130}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) h2 .n{color:#0a1130}}
h3{font-size:1.14rem;margin:34px 0 6px;font-weight:700;text-wrap:balance}
h4{font-size:1rem;margin:0 0 4px;font-weight:700}
p{margin:.7rem 0;max-width:66ch}
.lede{color:var(--fg-soft);font-size:1.03rem;max-width:62ch;margin:.2rem 0 1rem}
.nota-min{font-size:.92rem;color:var(--fg-soft);margin:.5rem 0 0}
ul,ol{max-width:66ch}
a{color:var(--brand)}
hr{border:0;border-top:1px solid var(--line);margin:56px 0}
header.top{padding-block:44px 0}
.kicker{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--brand);font-weight:800;margin:0 0 10px}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;border:1px solid var(--line);background:var(--surface-2)}

/* índice */
.toc{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px 22px;margin:28px 0 8px;box-shadow:var(--shadow)}
.toc h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--fg-soft);margin:0 0 10px;font-weight:800}
.toc ol{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:2px 18px}
.toc a{display:block;padding:5px 0;text-decoration:none;color:var(--fg)}
.toc a:hover{color:var(--brand)}

/* pode / não pode */
.pnp{margin:22px 0}
.pnp .bloco{border-radius:var(--r);padding:20px 22px;margin:14px 0;border:1px solid var(--line)}
.pnp .sim{background:var(--ok-bg);border-color:var(--ok)}
.pnp .nao{background:var(--no-bg);border-color:var(--no)}
.pnp h3{margin:0 0 10px;font-size:1.06rem}
.pnp .sim h3{color:var(--ok)} .pnp .nao h3{color:var(--no)}
ul.checks,ul.simlist{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
ul.checks li,ul.simlist li{position:relative;padding-left:28px}
ul.checks li::before,ul.simlist li::before{content:"✓";position:absolute;left:0;top:-1px;font-weight:800;color:var(--ok)}
.np{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.np h4{position:relative;padding-left:26px;color:var(--no)}
.np h4::before{content:"✕";position:absolute;left:0;top:0;font-weight:800}
.np .porque{margin:.3rem 0;font-size:.95rem;color:var(--fg-soft)}
.np .saida{margin:.4rem 0 0;font-size:.95rem}

/* prints em moldura de celular */
.shot{margin:20px 0;display:flex;flex-direction:column;align-items:center;gap:8px}
.phone{background:var(--phone);border-radius:30px;padding:9px;box-shadow:var(--shadow);max-width:100%}
.phone img{display:block;width:276px;max-width:100%;height:auto;border-radius:22px}
.shot figcaption{font-size:.88rem;color:var(--fg-soft);text-align:center;max-width:40ch}
@media (min-width:720px){
  .shot{float:right;margin:4px 0 18px 28px;max-width:300px}
  .shot+*{clear:none}
  h2,h3,hr{clear:both}
}

/* passos */
ol.steps{list-style:none;padding:0;counter-reset:s;max-width:62ch}
ol.steps>li{counter-increment:s;position:relative;padding-left:42px;margin:13px 0}
ol.steps>li::before{content:counter(s);position:absolute;left:0;top:0;width:28px;height:28px;border-radius:50%;background:var(--brand-soft);color:var(--brand);border:1.5px solid var(--brand);font-size:13.5px;font-weight:700;display:grid;place-items:center}

/* avisos */
.note{border-left:3px solid var(--brand);background:var(--brand-soft);border-radius:0 10px 10px 0;padding:13px 17px;margin:16px 0;max-width:66ch}
.note.importante{border-left-color:var(--brand);background:var(--brand-soft)}
.note.atencao{border-left-color:var(--warn);background:var(--warn-bg)}
.note.dica{border-left-color:var(--ok);background:var(--ok-bg)}
.note .tag{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;margin-bottom:3px}
.note.importante .tag{color:var(--brand)} .note.atencao .tag{color:var(--warn)} .note.dica .tag{color:var(--ok)}
.note p{margin:0;max-width:none}

/* resultado aprovado / recusado */
.res{border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin:16px 0;background:var(--surface)}
.res.ok{border-left:4px solid var(--ok)} .res.erro{border-left:4px solid var(--no)}
.res h4{color:var(--fg)} .res.ok h4{color:var(--ok)} .res.erro h4{color:var(--no)}
.res .shot{float:none;margin:14px auto 0;max-width:300px}

.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;margin:18px 0;box-shadow:var(--shadow);max-width:66ch}

/* tabelas */
.tw{overflow-x:auto;margin:16px 0;border:1px solid var(--line);border-radius:10px;background:var(--surface);max-width:66ch}
table{border-collapse:collapse;width:100%;font-size:14.5px;min-width:420px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--surface-2);font-weight:700;font-size:12.5px;white-space:nowrap}
tr:last-child td{border-bottom:0}
td:first-child{font-weight:600}

.theme{position:fixed;top:calc(env(safe-area-inset-top,0px) + 10px);right:12px;z-index:9;background:var(--surface);color:var(--fg-soft);border:1px solid var(--line);border-radius:999px;padding:6px 13px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;box-shadow:var(--shadow)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:4px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"""

JS = """
(function(){var b=document.getElementById('themeBtn');
function cur(){var a=document.documentElement.getAttribute('data-theme');if(a)return a;
return window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}
function lab(){b.textContent=cur()==='dark'?'tema claro':'tema escuro';}
try{var s=localStorage.getItem('guia-tema');if(s==='dark'||s==='light')document.documentElement.setAttribute('data-theme',s);}catch(e){}
lab();b.addEventListener('click',function(){var n=cur()==='dark'?'light':'dark';
document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('guia-tema',n);}catch(e){}lab();});})();
"""

pagina = f"""<title>Guia do App do Motorista</title>
<meta name="description" content="O que o motorista faz no app, o que o app nao aceita, e o que fazer quando algo da errado.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>{CSS}</style>
<button class="theme" id="themeBtn" type="button">tema</button>
<div class="wrap">
<header class="top">
  <p class="kicker">App do motorista</p>
  <h1>{e(d['titulo'])}</h1>
  <p class="sub">{e(d['subtitulo'])}</p>
  <p><span class="pill">Atualizado em {data_br}</span> <span class="pill">app.motorista.moveelog.com.br</span></p>
</header>

<div class="toc"><h2>Neste guia</h2><ol>
{chr(10).join(toc)}
<li><a href="#problemas">Quando algo dá errado</a></li>
</ol></div>

<h2 id="pode-nao-pode"><span class="n">★</span>{e(pnp['titulo'])}</h2>
<p class="lede">{e(pnp['nota'])}</p>
<div class="pnp">
  <div class="bloco sim"><h3>O que você pode fazer</h3><ul class="simlist">{pode_li}</ul></div>
  <div class="bloco nao"><h3>O que o app não aceita</h3>{nao_cards}</div>
</div>

{chr(10).join(secs)}

<hr>
<h2 id="problemas"><span class="n">?</span>{e(pb['titulo'])}</h2>
<p class="lede">{e(pb['intro'])}</p>
{grupos}

<hr>
<p class="lede">{e(d['rodape'])}</p>
<p class="nota-min">Este guia e a tela <strong>Ajuda</strong> dentro do app saem do mesmo arquivo de conteúdo
(<code>lib/ajuda-conteudo.json</code>), então as duas versões nunca divergem.</p>
</div>
<script>{JS}</script>
"""

SAIDA.write_text(pagina, encoding='utf-8')
print(f'HTML: {SAIDA}  ({round(len(pagina.encode())/1024,1)} KB)')
print(f'prints disponíveis: {len(existentes)} | usados na página: {len(set(usadas))}')
faltando = [s.get('img') for s in d['secoes'] if s.get('img') and s['img'] not in existentes]
if faltando: print('sem print (seção sai só com texto):', ', '.join(faltando))
