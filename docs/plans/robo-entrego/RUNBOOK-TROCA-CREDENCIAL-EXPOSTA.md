# Runbook — trocar a credencial do portal EntreGô (exposição pública)

Preparado em 2026-10-01. **A troca é do operador**; este documento existe para a
janela ser curta e para a ordem não ser improvisada na hora.

## O que aconteceu, medido

A senha da conta de serviço do portal EntreGô (`ENTREGO_SENHA`) estava **também**
como senha do basic-auth do painel `cstk` — e essa linha vivia num documento
**versionado** (`CONTINUAR-CSTK.md`), no HEAD de um repositório **público**.

Antes disso, a mesma senha já havia ficado em texto puro num scratchpad local de
28/08 a 16/09 (19 dias). O arquivo foi apagado em 16/09; **a senha nunca foi
trocada**.

Onde ela aparecia, em 01/10:

| Local | Natureza |
|---|---|
| `CONTINUAR-CSTK.md` (versionado, HEAD, **repo público**) | 🔴 exposição pública |
| `arquivos_complementares/CONTINUAR-SESSAO-2026-08-04.md` | untracked, só no servidor |
| `/root/cstk-up.sh` | fora do git (é o lugar certo dela) |
| `/root/.bash_history`, `/root/.claude/history.jsonl` | históricos locais |

Os dois primeiros foram limpos (PR da mesma data). Os históricos locais não são
reescritos — não vale o risco, e a mitigação real é a troca.

### ⚠️ Remover do arquivo NÃO resolve

O blob continua acessível pelo SHA do commit, e qualquer fork ou cache do GitHub
já o tem. **Em credencial exposta em repo público, a única mitigação é trocar.**
A limpeza é higiene, não correção.

### O que NÃO é exposição (verificado, para não gastar tempo de novo)

- `N8N_API_TOKEN` e `FASTAPI_VALIDATION_TOKEN` aparecem em
  `infra/hub/.env.hub.homolog.example` com os mesmos valores do `.env` em uso —
  mas os hosts são `n8n-mock` e `fastapi-mock`, containers do **ambiente
  isolado** do hub. São tokens de mock; estão no `.example` de propósito.
- `ngrok config add-authtoken <SEU_TOKEN>` no mesmo documento é **placeholder**.
- Varredura do repo (versionado e histórico) por chave privada, `ghp_`,
  `github_pat_`, `sk-`, `AKIA`, `xox[baprs]-`: **nada**.

## A troca, na ordem

⚠️ **A armadilha do timer** (esta é a parte que estraga o dia seguinte): o
`entrego-enriquecimento-sob-demanda.timer`, a cada 5 min e com fila vazia, faz
*keep-alive* da sessão do portal. É só isso que a mantém viva, porque **o refresh
token da EntreGô vive 60 min**. Sem o keep-alive, ~1 h depois a sessão morre e o
próximo import é forçado a **login completo**, que exige o **código de 6 dígitos
por e-mail** (IMAP, janela de 5 min) — e um atraso de entrega já derrubou o
import das 11h de 2026-09-07.

Logo: **troque e religue o timer antes das 11h.**

```bash
# 1. parar o keep-alive (só o timer; o serviço em curso termina sozinho)
systemctl stop entrego-enriquecimento-sob-demanda.timer
systemctl status entrego-enriquecimento-sob-demanda.timer --no-pager | head -3
```

2. **Trocar no portal EntreGô** (web), com senha nova e **exclusiva** — não
   reutilizar em nenhum outro sistema.

```bash
# 3. atualizar o segredo do robô (modo 600, dono root — já está correto)
#    edite só a linha ENTREGO_SENHA=
vi /var/lib/hub_secrets/robo-entrego/.env
stat -c '%n modo %a dono %U' /var/lib/hub_secrets/robo-entrego/.env   # espere: modo 600 dono root

# 4. invalidar a sessão salva, para o robô logar com a senha nova
#    (o caminho padrão está em src/index.js: STORAGE_STATE_PATH_DEFAULT)
ls -la /var/lib/hub_secrets/robo-entrego/

# 5. religar o keep-alive
systemctl start entrego-enriquecimento-sob-demanda.timer
```

6. **Trocar a senha do basic-auth do painel `cstk`** para um valor **diferente**
   do da EntreGô, e atualizar `/root/cstk-up.sh`.

## Validar depois (sem queimar a sessão)

Não force login em sequência: o PerimeterX observa exatamente esse padrão
(`ACHADOS-PORTAL.md` §6), e por isso o robô falha rápido em vez de retentar.
Deixe o próprio timer trabalhar e leia o resultado:

```bash
journalctl -u entrego-enriquecimento-sob-demanda.service --since '20 minutes ago' \
  | grep -E 'rodada concluída|Failed|antibot'
```

| Saída | Leitura |
|---|---|
| `rodada concluída` | ✅ senha nova aceita, sessão viva |
| `Failed` isolado, depois `rodada concluída` | transitório do portal; nenhuma ação |
| `Failed` em 3+ janelas seguidas | credencial errada no `.env`, ou portal fora |
| `ErroAntibotSuspeito` / `suspeita_antibot` | 🔴 pare. Não reexecute — queima a sessão compartilhada com o import diário |

No dia seguinte, confirme que o import das 11h rodou: é ele que prova que o
keep-alive sobreviveu à troca.

## Depois da troca, uma melhoria que vale

`/root/cstk-up.sh` guarda a senha do basic-auth em texto. Enquanto está fora do
git, é aceitável — mas o padrão do projeto para segredo é
`/var/lib/hub_secrets/` (modo 600), de onde o script pode ler. Isso evita que a
próxima cópia do script carregue a credencial junto.

## Varredura automatizada — gitleaks (2026-10-01)

A varredura manual desta frente foi por padrões escolhidos à mão. Rodamos o
`gitleaks` v8.30.1 por cima, para pegar o que não foi pensado.

**Histórico (347 commits, 17,8 MB): 2 achados, ambos falsos positivos.**

| Achado | Veredito |
|---|---|
| `evidencias/S6/followup-sc004-mv.md:94` | `Group Key: filtro_1.f_descricao` de um `EXPLAIN ANALYZE` — a regra lê "Key:" como atribuição |
| `infra/hub/testes/preflight-negativo.sh:29` | fixture dummy; o `sha256` do valor não bate com nenhum dos 4 `/var/lib/hub_secrets/.env.hub.*` reais |

Os dois estão allowlistados em `.gitleaks.toml` **com o motivo conferido**, não
suprimidos. Nenhum segredo real jamais entrou no histórico deste repositório.

**Working tree (597 MB, inclui não-versionados): 7600 achados, todos em arquivos
fora do git — mas um deles estava a um `git add -A` de distância.**

`arquivos_complementares/` tinha 3812 JWTs de comprovante da Transfeera
(`api.transfeera.com/pub/…` — link portador: quem tem o link vê o comprovante
bancário) e 7574 linhas de PII financeira, e **não estava no `.gitignore`** — só
duas subpastas estavam. A única defesa era a disciplina de `git add` por caminho
explícito. Agora a pasta inteira é ignorada. Os `.env` e `.claude/settings*`
apontados pela varredura já eram ignorados (conferido um a um).

### Como rodar, e a guarda

```bash
scripts/instalar-hook-gitleaks.sh      # binário pinado + hook pre-commit (prova sozinho que não está oco)
gitleaks git --redact .                # histórico inteiro
gitleaks dir --redact .                # working tree, inclui não-versionados
```

**Sempre `--redact`** — sem ele o relatório passa a ser o próprio vazamento.
Relatório com PII vai para `~/`, fora do git; no chat, só contagens.

⚠️ **Dois jeitos de a varredura passar sem provar nada**, os dois pegos aqui por
controle negativo: a regra `aws-access-token` exige **base32** (`AKIA` +
`[A-Z2-7]{16}`) — um valor de teste com `0/1/8/9` não casa; e valores de exemplo
da própria AWS (`…EXAMPLEKEY`) são allowlist da ferramenta. Teste de hook de
segredo sem controle negativo é teste oco.
