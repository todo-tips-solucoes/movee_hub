# Setup pleno da skill `ui-ux-pro-max` (Claude Code + zellij)

Data: 2026-08-04 · Host: VPSTodo · Repo: `/var/lib/envioMassa_homologacao`
Upstream: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill

> Nada aqui toca produção (Swarm, `chatmasterveloz`, Traefik). É configuração de
> ferramental do agente em `~/.claude/` e `.claude/` (este último é gitignored).

---

## 1. Diagnóstico do estado atual (verificado, não presumido)

| Item | Estado | Evidência |
|---|---|---|
| Marketplace registrado | ✅ | `~/.claude/plugins/known_marketplaces.json` → `nextlevelbuilder/ui-ux-pro-max-skill` |
| Plugin instalado | ✅ scope `project` em `/var/lib/envioMassa_homologacao` | `installed_plugins.json` → v2.6.2, commit `3da52ff`, 2026-07-11 |
| Cache do plugin íntegro | ✅ 15 MB | `~/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/2.6.2` |
| Skills carregadas na sessão | ✅ 7/7 | `ui-ux-pro-max:{ui-ux-pro-max,design,design-system,brand,ui-styling,banner-design,slides}` |
| Datasets | ✅ | `styles.csv` 85 linhas, `colors.csv` 193, `products.csv` 193, `google-fonts.csv` 1924, `ux-guidelines.csv` 99, `charts.csv` 26, 16 stacks em `data/stacks/` |
| `search.py` executa | ✅ | `python3 .../scripts/search.py "fleet management dashboard logistics" --design-system -p "Movee Hub"` → design system completo (pattern + colors + typography + effects) |
| Busca por domínio | ✅ | `--domain style|color|typography|chart|guideline|product` retornam resultados |
| Python 3.12 / Node 22 / npm 10 | ✅ | stdlib-only nos `.py`; `.cjs` do `brand`/`design-system` rodam em node |
| **Ativação explícita** | ✅ | `.claude/settings.json` do projeto → `"enabledPlugins": {"ui-ux-pro-max@ui-ux-pro-max-skill": true}` (o `settings.local.json` habilita `context-mode` e `ponytail`; o `~/.claude/settings.json`, `context-mode`) |
| **Versão** | ⚠️ | local `3da52ff` / v2.6.2 · upstream `4d140cf`, tag **v2.13.0** — muito defasado (o próprio frontmatter do SKILL.md diz "50+ styles, 10 stacks" enquanto os dados já têm 85 estilos e 16 stacks) |
| **`GEMINI_API_KEY`** | ❌ ausente | exigido por `design/scripts/{logo,cip,icon}/generate.py` — logo, CIP e ícones não geram |
| **Browser headless** | ❌ ausente no host | `banner-design`, `design/social-photos`, export de `slides` fazem HTML→PNG |
| shadcn/Radix vs Base UI | ℹ️ | `ui-styling` assume shadcn/Radix; o `frontend_v2` usa **Base UI** — nunca rodar `npx shadcn init` no projeto |
| Duplicidade de skill | ✅ nenhuma | não há cópia antiga em `~/.claude/skills/` |

**Conclusão:** o núcleo (a inteligência de design: estilos, paletas, tipografia,
UX guidelines, gerador de design system) está **100% operacional agora**. O que
não funciona é só o que depende de API externa (Gemini) e de renderizar imagem.

---

## 2. Plano

### Fase 1 — Ativação explícita — ✅ JÁ FEITA (verificado 2026-08-04)

`.claude/settings.json` do projeto já contém:

```json
"enabledPlugins": { "ui-ux-pro-max@ui-ux-pro-max-skill": true }
```

Nada a fazer. Comando de conferência:

```bash
jq -c '.enabledPlugins' .claude/settings.json
```

Nota: os plugins estão espalhados por três arquivos — `settings.json` (projeto)
habilita o `ui-ux-pro-max`, `settings.local.json` (projeto) habilita
`context-mode` e `ponytail`, e `~/.claude/settings.json` (usuário) habilita
`context-mode`. Funciona, mas ao depurar "sumiu a skill X" é preciso olhar os três.

### Fase 2 — Atualizar 2.6.2 → 2.11.0 — ✅ FEITA (2026-08-04)

Resultado: **v2.11.0, commit `4d140cf`** (HEAD do upstream), 7 skills, 22 stacks
(eram 16), `search.py` EXIT=0. O `/plugin install` recarregou as skills na sessão
viva — **não foi preciso reiniciar nem dar `/clear`**. Rollback: cache `2.6.2`
permanece em `~/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/2.6.2`.

> A tag `v2.13.0` do repositório versiona o pacote npm `ui-ux-pro-max-cli`
> (`.releaserc.json` → `pkgRoot: cli`), não o plugin. Plugin e CLI têm versões
> distintas; comparar plugin com plugin (`.claude-plugin/plugin.json`).

Comandos usados, para repetir no futuro:

```
/plugin marketplace update ui-ux-pro-max-skill
/plugin install ui-ux-pro-max@ui-ux-pro-max-skill
```

Depois reiniciar a sessão (skills são lidas no boot).

Verificação (rodar depois do restart):

```bash
jq -r '.plugins["ui-ux-pro-max@ui-ux-pro-max-skill"][0] | .version, .gitCommitSha' \
  ~/.claude/plugins/installed_plugins.json
NEW=$(ls -d ~/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/* | tail -1)
python3 "$NEW/.claude/skills/ui-ux-pro-max/scripts/search.py" "logistics dashboard" --domain style | head -20
```

Risco: as skills novas podem renomear scripts/flags. É reversível — o cache
antigo (`.../2.6.2`) continua no disco; para voltar, `/plugin uninstall` +
`/plugin install ui-ux-pro-max@ui-ux-pro-max-skill@2.6.2` ou restaurar a entrada
no `installed_plugins.json`. Anotar a versão anterior antes: **2.6.2 / `3da52ff`**.

### Fase 3 — Ligar os recursos que faltam

#### 3a. Gemini (logo, CIP, ícones) — habilita a skill `design`

Chave em https://aistudio.google.com/apikey. **Não** exportar no `~/.bashrc`:
o `.bashrc` deste host tem o guard `[ -z "$PS1" ] && return`, então shells não
interativos (os que a ferramenta Bash usa) não veriam a variável — e o zellij
piora isso (ver Fase 4). O caminho confiável é o Claude Code injetar a env:

`.claude/settings.local.json` (gitignored, escopo só deste projeto):

```jsonc
{
  "env": { "GEMINI_API_KEY": "AIza..." }
}
```

Verificação:

```bash
python3 ~/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/*/.claude/skills/design/scripts/logo/generate.py \
  --brand "Movee" --style minimalist --industry logistics
```

Deve gerar PNG(s); sem a chave o script aborta pedindo `GEMINI_API_KEY`.

Custo: chamadas a `gemini-2.5-flash-image` / `gemini-3-pro-image-preview` são
pagas. Se não for gerar identidade visual, **pule esta fase** — as outras 6
skills não dependem dela.

#### 3b. HTML → PNG — ✅ FEITA (2026-08-04): `scripts/html-to-png.sh`

**O que as skills esperavam e não existe aqui.** `banner-design` (e o
`social-photos` da skill `design`) mandam chamar
`node .claude/skills/chrome-devtools/scripts/screenshot.js`. Essa skill
`chrome-devtools` **não está instalada** — assim como `ai-artist`,
`ai-multimodal` e `frontend-design`, todas citadas pelo `banner-design`. São do
ecossistema *claudekit* do mesmo autor e não vêm no plugin.

**Substituto entregue:** `scripts/html-to-png.sh`, que reusa a imagem
`mcr.microsoft.com/playwright:v1.61.1-jammy` (já baixada, 3,24 GB) e o
`node_modules/playwright` do `frontend_v2` (mesma versão 1.61.1) — zero
instalação nova, nada de chromium no host, `--memory=1g` pelo rito
anti-starvation.

```bash
scripts/html-to-png.sh <entrada.html> <largura> <altura> <saida.png> [escala]

# dimensão exata da plataforma (LinkedIn 1500x500)
scripts/html-to-png.sh assets/banner.html 1500 500 assets/banner.png
# retina 2x (sai 2160x2160)
scripts/html-to-png.sh assets/post.html 1080 1080 assets/post@2x.png 2
```

Detalhes que custaram uma iteração e ficam registrados:

- a CLI `playwright screenshot` **não** tem `--device-scale-factor`; o script usa
  a API (`newPage({ deviceScaleFactor })`) para o 2x funcionar de verdade;
- entrada e saída precisam estar sob o diretório atual (é ele que vira `/w`);
- o script confere o `IHDR` do PNG e falha se a dimensão não bater — sem deps;
- `waitUntil: networkidle` + `HTML_TO_PNG_WAIT_MS` (default 1500) dão tempo a
  webfonts e Chart.js. **Validado:** slide 1280×720 com Chart.js via CDN
  renderizou o gráfico dentro do container.

**Consequência para `banner-design`:** o passo de *export* está resolvido, e o de
*composição* (HTML/CSS: gradiente, tipografia, geométrico, glassmorphism,
duotone, editorial) funciona sem nada extra. O que continua indisponível é só a
geração de **visual por IA** (`ai-artist`/`ai-multimodal` + Gemini) — banners que
dependam de ilustração/foto gerada precisam da Fase 3a ou de uma imagem externa.

**`slides` não dependia disso**: ela só produz HTML com Chart.js e tokens, e já
funcionava. O script serve para exportar os slides como imagem quando quiser.

#### 3c. `ui-styling` × Base UI (só documentação)

A skill sugere `npx shadcn@latest init/add`. O `frontend_v2` usa **Tailwind 4 +
Base UI (`@base-ui/react`)**, não Radix. Usar a skill para *tokens, espaçamento,
contraste, estados e acessibilidade*; **descartar** os comandos `shadcn` e traduzir
os componentes para o equivalente Base UI (lembrar do gotcha: `Select` exige
`items` no Root).

### Fase 4 — Zellij

Nada da skill depende do zellij; o que quebra é a **herança de ambiente**:

- o `zellij` roda um servidor persistente; abas/panes novas herdam o env de quando
  o **servidor** subiu, não do shell atual. Se optar por exportar a chave no
  shell em vez de `settings.local.json`, é obrigatório `zellij kill-server` e
  abrir sessão nova, senão o Claude Code não enxerga a variável.
- Usar `settings.local.json` (Fase 3a) contorna isso inteiramente — recomendado.
- O `search.py` imprime caixas Unicode de ~90 colunas. Em pane estreita o layout
  quebra. Rodar a skill em pane larga, ou pedir saída markdown:
  `... --design-system -f markdown`.
- Cópia do output: usar o scrollback do zellij (`Ctrl+s` → modo scroll) ou
  redirecionar para arquivo — mais confiável que selecionar arte ASCII com o mouse.

### Fase 5 — Checklist final de "instalação OK"

```bash
# 1. plugin declarado e habilitado
jq '.enabledPlugins' /var/lib/envioMassa_homologacao/.claude/settings.json
# 2. versão instalada
jq -r '.plugins["ui-ux-pro-max@ui-ux-pro-max-skill"][0].version' ~/.claude/plugins/installed_plugins.json
# 3. as 7 skills existem no cache
ls ~/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/*/.claude/skills/
# 4. motor de busca responde
S=$(ls -d ~/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/*/.claude/skills/ui-ux-pro-max/scripts/search.py | tail -1)
python3 "$S" "fleet management dashboard" --design-system -p "Movee Hub" | head -5
# 5. (opcional) gemini
[ -n "$GEMINI_API_KEY" ] && echo "gemini OK" || echo "gemini ausente (logo/CIP/icon inoperantes)"
```

E, dentro da sessão do Claude Code, os invocáveis:

| Comando | Para quê |
|---|---|
| `/ui-ux-pro-max:ui-ux-pro-max` | design system, paletas, tipografia, UX guidelines, charts |
| `/ui-ux-pro-max:design-system` | tokens em 3 camadas (primitive→semantic→component) |
| `/ui-ux-pro-max:ui-styling` | componentes/Tailwind (adaptar de shadcn → Base UI) |
| `/ui-ux-pro-max:brand` | identidade, tom de voz, sincronizar marca → tokens |
| `/ui-ux-pro-max:design` | logo/CIP/ícone (**precisa Gemini**) |
| `/ui-ux-pro-max:banner-design` · `:slides` | banners e apresentações (export precisa 3b) |

---

## 3. Ordem recomendada

1. ~~Fase 1 (ativação explícita)~~ — já estava feita.
2. ~~Fase 2 (update)~~ — feita 2026-08-04: 2.6.2 → **2.11.0**.
3. ~~Fase 3b (HTML→PNG)~~ — feita: `scripts/html-to-png.sh`, validado em 3 formatos.
4. Fase 3a (Gemini) — só se for gerar identidade visual ou visual de banner por IA; tem custo por chamada.
5. Fase 3c/4 — leitura, não execução.

**Estado em 2026-08-04:** operacionais — `ui-ux-pro-max`, `design-system`,
`brand`, `ui-styling`, `slides` e `banner-design` (composição CSS + export).
Pendente só o que depende de `GEMINI_API_KEY`: skill `design` inteira
(logo/CIP/ícone) e a etapa de visual-por-IA do `banner-design`.
