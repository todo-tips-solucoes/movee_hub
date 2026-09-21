# Briefing de retomada — o que sobrou em 2026-09-21

Prompt para sessão limpa. **Leia o `CLAUDE.md` do repositório antes de qualquer coisa**:
o ambiente chamado "homologação" É produção, o ciclo git é cláusula pétrea e
**autorização é por etapa**. Repositório é público — nenhum dado pessoal real em código,
teste, log ou documento.

Tudo aqui foi **medido**, não suposto. Onde é hipótese, está dito — e a sessão anterior
mostrou por que isso importa: uma hipótese registrada como "provável defeito de produto"
se revelou **falsa**, e teria mandado alguém caçar um bug inexistente.

---

## 1. Estado, para não refazer o que já está feito

`main` em **`c95ecb8`** (ou adiante). Em 2026-09-20/21 fecharam 8 PRs:

| PR | O que entregou | Em produção? |
|---|---|---|
| #193 | baselines dos drivers de integração a zero | n/a (teste) |
| #194 | `next 16.2.3 → 16.3.5`, advisory **crítica** eliminada | ✅ `next-1635-83afbfa` |
| #195/#198/#199 | briefing das falhas do E2E (aberto, atualizado, fechado) | n/a (doc) |
| #196 | `sessao-expira` — era teste, não produto | n/a (teste) |
| #197 | 3 permissões em código cru + card "Avisos" sem descrição | ✅ `rotulos-ui-ab111c5` |
| #199 | rótulo do filtro de faturamento | n/a (teste) |
| — | `e2e-guard` (`c95ecb8`) | ⚠️ **timer NÃO instalado** |

**E2E do hub: 133/5 → 139/0.** As 4 falhas herdadas estão fechadas
(`docs/plans/e2e-hub-falhas-herdadas/BRIEFING.md`). Qualquer falha agora é regressão.

**Produção hoje:** `frontend_v2` em `rotulos-ui-ab111c5` · `frontend_motorista` em
`next-1635-83afbfa` · `backend` em `repasse-us6-3e865c9`.

---

## 2. O que sobrou, por ordem de valor

### 2.1 🔴 Destravar o adiantamento — valor de negócio parado

**A feature está em produção desde 2026-09-19 e NÃO está em uso.** Enquanto o módulo não
for ligado para a entidade, o motorista vê as abas novas e o recurso responde
indisponível. Foram 3 PRs, migrations até a 0086 e 3 deploys — e ninguém consegue usar.

São **tarefas do operador no banco de produção** (`chatmasterveloz`), que o agente **não
executa** (cláusula pétrea). O agente pode preparar SQL, runbook e conferências.

Passos, na ordem — **a 3 depende da 2**:

1. **Ligar o módulo `adiantamentos`** para a entidade.
2. **Atribuir o papel `financeiro`** a um usuário (nasceu na migration 0070; ninguém está
   nele). ⚠️ `UsuarioEntidade` tem `UNIQUE (usuario_id, empresa_id)`: **um usuário = UM
   papel por entidade**. Não dá para somar — ou se troca o papel de alguém, ou se cria
   usuário próprio. Medido no hub-homolog em 2026-09-20.
   ⚠️ E `admin_entidade` **já tem as 10 permissões `adiantamentos.*`**, idênticas às do
   `financeiro`: trocar o papel de um admin não daria acesso novo, só tiraria o que ele já
   tem. O papel `financeiro` serve para dar acesso RESTRITO a quem não deve ser admin.
3. **`SELECT hub_entregador_documento_carregar_do_enriquecimento();`** — exige
   `adiantamentos.contas_revisar`, por isso depende do passo 2.
4. **Definir a configuração inicial**, testar o upload na Transfeera **sem confirmar
   pagamento**, e rodar a carga de contas com `--simular` primeiro.
5. O botão **"fechar apuração" está liberado**. ⚠️ Em produção a semana de apuração começa
   na **SEGUNDA** (`apuracao_dia_inicio = 1`): a gravação recusa janela que comece noutro
   dia, com `PERIODO_DESALINHADO`.

Origem: `docs/plans/adiantamento-motorista/BRIEFING-DIVIDA-RESTANTE.md` §4.

### 2.2 ~~Instalar o timer do `e2e-guard`~~ ✅ JÁ ESTÁ INSTALADO

**Medido em 2026-09-21:** os symlinks já existem em `/etc/systemd/system/` (criados 03:27,
mesmo padrão do `cert-guard`/`disco-guard`), `systemctl is-enabled` → `enabled`,
`is-active` → `active`, próximo disparo confirmado no `list-timers`. O item abaixo ficou
obsoleto entre a escrita deste briefing e a sessão seguinte.

Resíduo único: o `systemctl status` avisa que o unit mudou no disco depois do link
(`daemon-reload` pendente). Não impede o disparo.

<details><summary>Comandos originais (já executados)</summary>

```bash
sudo ln -sf /var/lib/envioMassa_homologacao/infra/producao/e2e-guard.service /etc/systemd/system/
sudo ln -sf /var/lib/envioMassa_homologacao/infra/producao/e2e-guard.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now e2e-guard.timer
systemctl list-timers e2e-guard.timer          # confirmar o próximo disparo (05:00)
```

Antes de ligar, vale rodar à mão uma vez: `node infra/producao/e2e-guard.js --dry-run`.

⚠️ **Conferir como cert-guard/disco-guard foram instalados neste host** (symlink? cópia?) e
seguir o mesmo caminho — não inventar um terceiro jeito.

</details>

### 2.3 ~~Backend — `bcrypt@6` e `jsonwebtoken@9`~~ ✅ FEITO (branch `chore/backend-bumps-auth`)

**Resultado (2026-09-21):** `bcrypt@5.1.1→6.0.0`, `jsonwebtoken@8.5.1→9.0.3`,
`multer@1.4.4→2.4.0`. Vulnerabilidades **15 → 8**, a CRITICAL eliminada. Suíte
**1538 → 1541 / 0** (3 testes novos, abaixo).

🔴 **O achado que quase derrubou produção: `node-fetch` era dependência FANTASMA.** O
`server.js:13` faz `require('node-fetch')` e o pacote **nunca esteve no `package.json`** —
vinha de carona como transitivo de `bcrypt@5` → `@mapbox/node-pre-gyp`. O bump removeu
essa árvore (65 pacotes) e o backend passou a morrer no boot com `MODULE_NOT_FOUND`.
**Os 1538 testes passaram mesmo assim**, porque nenhum carrega o `server.js` (ele dá
`listen`). Só apareceu ao subir o container de verdade. Corrigido declarando
`node-fetch@^2.7.0` (a mesma versão que já rodava; a 3.x é ESM-only e quebraria o
`require`).

⚠️ **A lição vale além deste PR:** a bomba já estava armada antes do bump — qualquer
`npm install` que reorganizasse a árvore de transitivos derrubaria o backend. E o gate que
existia (suíte verde) não via. Ficou um teste (`tests/dependencias-declaradas.test.js`)
que lê os `require()` do código e confere contra o `package.json`, pegando a classe
inteira do problema sem carregar nada. Controle negativo conferido: sem a correção ele
falha nomeando `node-fetch — usado em server.js`.

<details><summary>Contexto original do item (pré-execução)</summary>

`npm audit --omit=dev` no backend: **15 vulnerabilidades, 1 CRITICAL, 10 HIGH** (medido
2026-09-20). Três caem de uma vez com `bcrypt@6` (`tar`, `@mapbox/node-pre-gyp`, `bcrypt`).

⚠️ **São MAJORS que mexem em hash de senha e em toda a autenticação.** Risco de outra
natureza que o bump de minor do Next — merece PR próprio, janela própria, e os **1538
testes** do backend como rede.

⚠️ **Contexto honesto sobre a CRITICAL:** é o `tar`, via `node-pre-gyp`, que roda em
**install-time**, não em runtime. O risco real é menor que a etiqueta sugere. É higiene,
não emergência.

- `multer@2.4` resolve `busboy`/`dicer`/`multer` (minor dentro do 2.x).
- `jsonwebtoken@9` é major — conferir breaking changes de `verify`/`sign`.
- ⚠️ **`xlsx@0.18.5` continua SEM correção publicada** (`fix=NAO`, reconfirmado). A
  mitigação real é a do PR #183: o parser CSV próprio tirou o arquivo de terceiro do
  `XLSX.read`. O que resta é o servidor relendo arquivo que ele mesmo gerou.

Baseline do backend: `npm test` = **1538/0**.

</details>

**O que ficou deliberadamente de fora do PR:** as 8 vulnerabilidades restantes (6 delas com
`npm audit fix` não-breaking disponível: `axios`, `body-parser`, `brace-expansion`,
`form-data`, `qs`, `follow-redirects`). O `axios` é o canal com PostgREST/n8n/FastAPI —
minor dele já quebrou coisa neste repo, então merece PR e verificação próprios. `xml2js`
(moderate) é breaking e parseia NFe. `xlsx` segue sem correção publicada.

### 2.4 ~~Rótulo da barra do app motorista~~ ✅ DECIDIDO: fica como está

**Decisão do operador em 2026-09-21: não mexer.** O estouro é de 1px de espaço em branco
num aparelho de 320px, sem colisão visual — não paga o custo de trocar o nome de um item
de navegação que o motorista já aprendeu. Item encerrado; reabrir só se aparecer colisão
real medida.

<details><summary>Análise original</summary>

"Notificações" (12 caracteres) estoura a coluna em **1px num aparelho de 320px**. Sem
colisão visual: a vizinha "Conta" tem 41px livres, e o que invade é espaço em branco.
Medido no DOM via Playwright, não estimado.

O remédio é **encurtar o rótulo** (foi o que resolveu "Adiantamento" → "Adiantar"), mas
**"Avisos" colide** com a palavra que o app já usa para as mensagens push (`/avisos/[id]`).
Candidatos: "Alertas", "Mensagens". **É escolha do operador** — o agente não decide nome de
produto.

Origem: `docs/plans/adiantamento-motorista/BRIEFING-DIVIDA-RESTANTE.md` §2.3.

</details>

### 2.5 Dívida de processo, se sobrar fôlego

48 itens `[x]` das FASES 1–3 do adiantamento sem âncora de evidência. Amostragem de 5 foi
ao código e conferiu, mas a amostra é 5 de 48. **Ao reabrir qualquer coisa daquelas fases,
tratar como NÃO auditável por leitura:** a verificação é reexecutar as suítes, não reler o
`tasks.md`.

---

## 3. Como verificar, e com o que comparar

| Gate | Baseline (medida 2026-09-21) |
|---|---|
| backend `npm test` | **1541 / 0** (era 1538; +3 em `dependencias-declaradas`) |
| painel `vitest` | **724 / 724** |
| app motorista `npm test` | **97 / 97** |
| `tsc --noEmit` (dois frontends) | limpo |
| E2E do hub | **139 / 0** |
| `hub-adiantamentos-integration.sh` | 231 / 0 |
| suíte agregada do hub | **sem falha herdada** (PR #193) |
| driver RLS de importações | **19 / 0** (PR #193) |

`npm run lint` **não roda** neste repo (falta `eslint.config.js` desde que o Next 16
removeu o `next lint`). Condição pré-existente — não é gate.

---

## 4. ⚠️ Os enganos que custaram tempo, para não repetir

Todos foram pagos na sessão de 20–21/09.

- ⚠️ **Suíte verde não prova que o processo SOBE.** (2026-09-21) Os 1538 testes passaram
  com o backend incapaz de bootar: nenhum deles carrega o `server.js`, porque ele dá
  `listen`. A falha só apareceu ao subir o container. **Depois de mexer em dependências,
  subir o backend e ler o log é gate, não zelo extra** — e o sintoma (`MODULE_NOT_FOUND`)
  chegaria no E2E disfarçado de "login quebrado", mandando caçar o bug no lugar errado.
- **Hipótese é hipótese.** A de `sessao-expira` apontava defeito de produto e era **falsa**
  — o produto estava certo e o teste é que media o caminho errado. Medir o mecanismo antes
  de mexer, e **desconfiar quando "corrigir o produto" significaria desfazer uma decisão
  deliberada**.
- **O que o teste acusa pode ser só a ponta.** O E2E nomeava 1 permissão em código cru e
  eram **3**: as outras duas têm DOIS pontos no código e o regex do próprio detector
  (`/^[a-z_]+\.[a-z_]+$/`) não as via. Conferir contra a fonte de verdade (o banco), não
  contra a lista que o teste carrega.
- **Lista fixa sai de sincronia em silêncio.** Aconteceu 2× em uma sessão: contagem de
  módulos (`=== 9`, havia 12) e lista de permissões (43 no unit, 49 no banco). Asserção de
  catálogo deve conferir **conjunto**, nunca contagem.
- **Nome de variável ≠ o que o código lê.** Procurei `VAPID_PUBLIC_KEY`/`PRIVATE`/`SUBJECT`
  e conclui que o push não estava configurado; o backend lê **`VAPID_KEYS_FILE`** (um JSON)
  e estava tudo certo. Conferir o que o código lê, não o nome esperado.
- **`has_table_privilege` devolve `false` quando o GRANT é por COLUNA.** Ler isso como
  "falta GRANT" leva a "consertar" reabrindo PII. Usar `has_column_privilege`.
- **O driver de E2E NÃO builda o frontend.** Testar sem rebuildar dá **teste oco**. E logo
  após o `up`, o cold start derruba o `global-setup` por timeout — parece quebra de login.
- **O container do Playwright reescreve `package-lock.json`** (1027 linhas) e sobrescreve
  PNGs versionados. Conferir `git diff --stat` e restaurar antes de commitar.
- **Porta local 8443 caiu em faixa reservada do Windows** no acesso por túnel: o `-v` mostra
  `bind [127.0.0.1]:8443: Permission denied`, só o IPv6 sobe, e o sintoma é **timeout, não
  "connection refused"**. Trocar a porta local (18443). Ver [[acesso-teste-hub-homolog]].

---

## 5. Onde cada coisa está registrada

- **Falhas do E2E (fechadas):** `docs/plans/e2e-hub-falhas-herdadas/BRIEFING.md`
- **Dívida do adiantamento:** `docs/plans/adiantamento-motorista/BRIEFING-DIVIDA-RESTANTE.md`
- **Deploys:** memórias `producao-2026-09-20` e `producao-2026-09-21` (esta traz a prova de
  bundle **pela string servida**, que é melhor que por hash de chunk)
- **Acesso ao hub-homolog por túnel SSH:** memória `acesso-teste-hub-homolog`
- **O guard:** `infra/producao/e2e-guard.js` (cabeçalho explica as decisões)
