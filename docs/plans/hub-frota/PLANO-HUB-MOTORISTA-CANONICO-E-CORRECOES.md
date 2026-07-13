# Plano — Motorista canônico do hub (uuid) + correções de navegação e filtros

> Elaborado em 2026-07-12 a partir de pedido do operador. Briefing de entrada para
> `/feature-00c` (pipeline SDD autônoma). Executar **somente** em recursos `hub-*`
> (exceção standing G1); produção intocada — cláusula pétrea vale integralmente.

## 0. Sumário executivo

Três frentes, em ordem de risco crescente:

| WS | Frente | Tamanho | Risco |
|----|--------|---------|-------|
| A | Corrigir 404 do "Painel Geral" + perfil do usuário em **modal** (não página) | P | baixo |
| B | Filtro "ID do entregador" do faturamento → **combobox por nome** (min. 3 letras, busca server-side) | M | baixo |
| C | Módulo Motoristas do hub vira o **gestor real** dos motoristas da empresa, com o **uuid da planilha** (`Entregador.id_externo`) como chave de ligação de todas as atividades (app motorista + hub) | G | alto |

## 1. Diagnóstico (evidências verificadas em 2026-07-12)

### 1.1 "Painel Geral" → 404 (raiz confirmada)

- A tabela `Modulo` do hub tem `codigo='dashboard', nome='Painel Geral'` (linha 1, ordem 10).
- `moduloParaRota()` é convenção pura `/hub/dashboard/<codigo>` **sem exceções**
  (`frontend_v2/lib/hub/module-nav.ts`, função no fim do arquivo). Para o módulo
  `dashboard` isso gera **`/hub/dashboard/dashboard`** — rota que não existe (404
  reproduzido via curl autenticado). A home real é `/hub/dashboard` (200).
- O bug atinge **dois** lugares que usam `moduloParaRota`: o item da sidebar
  (`components/hub/module-nav.tsx`) e o **card da home**
  (`app/hub/dashboard/page.tsx:38-39`) — o card "Painel Geral" da própria home
  aponta para o 404.

**Correção**: caso especial documentado em `moduloParaRota` — `codigo === 'dashboard'`
→ `/hub/dashboard`. Atualizar também o cálculo de item ativo
(`pathname === moduloParaRota(codigo)`) que passa a casar a home. Testes:
`module-nav` unit + render do nav e da home. (Alternativa descartada: renomear o
codigo no banco — quebraria RBAC/seeds/auditoria por nada.)

### 1.2 Ícone do usuário → 404 e pedido de modal

- O botão do header é o `AccountMenu` (`components/hub/account-menu.tsx`), que abre
  dropdown com "Meu perfil" → `Link href="/hub/dashboard/perfil"`.
- A rota `/hub/dashboard/perfil` **existe e responde 200** hoje (curl autenticado no
  hub-homolog atual). O 404 relatado provavelmente ocorreu em build intermediário.
  De todo modo, o pedido do operador é **abrir modal, não página** — o que elimina a
  navegação e o risco.
- Conteúdo atual da página de perfil (vira o conteúdo do modal): `usuario.nome` +
  `usuario.email` (read-only, de `/me`) + ação "Trocar senha" que chama
  `recuperarSenha(usuario.email)` (mesmo POST `/api/v1/auth/recuperar-senha`) com
  feedback de sucesso/erro (`app/hub/dashboard/perfil/page.tsx`).

**Correção**: novo `components/hub/perfil-dialog.tsx` (idioma do
`motorista-detalhe-dialog`: hook `usePerfilDialog` + `Dialog` Base UI). O item
"Meu perfil" do AccountMenu abre o modal. A rota `/hub/dashboard/perfil` permanece
(deep-link/fallback) reusando o mesmo miolo, ou redireciona — decisão D-A1 abaixo.

### 1.3 Motoristas geridos no legado (estado real)

Hoje existem **três** entidades e a gestão de verdade mora no legado:

| Entidade | Onde | Papel hoje |
|---|---|---|
| `Motorista` (legado, chatmasterveloz; pós-G3 também no schema legado do banco do hub via migration 0033) | base de **login/validação NF do app motorista** (PWA `app.motorista.*`): `cnpj_prestador`, `senha`, `nome`, `ativo` | CRUD completo na tela **legada** `/dashboard/motoristas` (editar nome/ativo, resetar senha, desativar/reativar; upsert automático via upload do grupo Movee) |
| `Entregador` (hub, 0010) | dimensão dos CSVs: `id_empresa`, **`id_externo uuid` (o uuid da planilha de performance/faturamento)**, `nome`, `ativo`, `motorista_id` | upsert só pela importação (`hub-import-processor.js:331` `on_conflict=id_empresa,id_externo`); PATCH do hub só permite `nome`/`ativo` (`validarPatchMotorista`, allowlist estrita) |
| `ContaMotorista` (hub, 0021) | **espelho read-mostly** da base do app motorista (`cnpj_prestador` UNIQUE, `nome`, `ativo`, `cadastro_completo`); populada por seed no homolog, nunca por sync | alvo do vínculo `Entregador.motorista_id` (FK física + índice único parcial = 1 conta ↔ 1 entregador) |

Ou seja: o módulo Motoristas do hub hoje **aponta/vincula** para a base do legado
(via espelho), exatamente o comportamento que o operador quer eliminar.

**Objetivo do WS-C**: o hub passa a ser a **fonte de verdade** da gestão de
motoristas da empresa; o `id_externo` (uuid) do `Entregador` é a **chave de ligação
de todas as atividades** do motorista, no app do motorista e no hub.

### 1.4 Filtro "ID do entregador" no faturamento

- `app/hub/dashboard/faturamento/page.tsx:456-462`: `Input` numérico de id — inusável
  para humanos. Backend filtra `entregador_id=eq.N`
  (`routes/hub-faturamento.js:109`).
- Infra pronta para busca por nome: extensões `unaccent` + `pg_trgm`,
  `hub_normaliza_nome()` e índice trgm já existem (0021); `Entregador` tem índice
  `(id_empresa, nome)` (0010). Idioma de combobox com busca já existe
  (`EntidadeCombobox` do admin: Popover+Command, F3).
- A tela performance tem o mesmo filtro (`performance/page.tsx`, campo
  `entregadorId`) — espelhar por consistência.

## 2. Decisões propostas (defaults para a pipeline) e pontos de clarify

**Decisões já tomadas (seguir sem perguntar):**

- **D-A0**: `moduloParaRota('dashboard') → '/hub/dashboard'` como caso especial
  comentado; nenhum rename no banco.
- **D-A1**: manter a rota `/hub/dashboard/perfil` viva reusando o mesmo componente de
  conteúdo do modal (zero duplicação); AccountMenu passa a abrir o modal.
- **D-B0**: combobox de entregador com **busca server-side por nome**: novo endpoint
  aditivo `GET /api/v1/faturamento/entregadores?busca=<termo>` (gate
  `faturamento.listar`, mínimo 3 caracteres — validar com `termoBuscaValido` de
  `hub-motoristas-similaridade.js` —, `ILIKE` sobre `hub_normaliza_nome(nome)` com
  escopo `id_empresa`, limite 20, retorno `{items:[{id, nome}]}`). Debounce de 300 ms
  no front; Popover+Command (idioma do admin); item selecionado exibe o nome e envia
  `entregadorId`; botão limpar. Espelhar em `/performance/entregadores`
  (gate `performance.listar`) e na tela performance. A regra existente
  entregadorId × comEntregador=false (contradição, faturamento/page.tsx:140-147)
  continua valendo.
- **D-B1**: fallback de acessibilidade/performance: se a busca falhar (5xx), o campo
  degrada para input de texto livre que filtra por nome via parâmetro já aceito?
  **Não** — degrada para o input numérico atual (menor superfície); registrar em
  comentário.
- **D-C0 (arquitetura)**: **não criar tabela nova**. Promover `Entregador` a
  motorista canônico do hub. `ContaMotorista` vira a **credencial de acesso** do
  motorista (cnpj+senha do app), sempre subordinada ao Entregador. O uuid
  (`id_externo`) é imutável e único por empresa (constraint já existe) e passa a ser
  exposto em lista/detalhe/DTOs do módulo motoristas.
- **D-C1 (CRUD no hub)**: a tela `/hub/dashboard/motoristas` ganha, além do que já
  tem: **criar motorista** (nome obrigatório; uuid: ver clarify Q2), **editar**
  (nome/ativo — já existe), **gerir credencial**: criar conta de acesso
  (cnpj_prestador + senha inicial/reset por token), resetar senha, ativar/desativar
  conta — espelhando as ações da tela legada (`Pencil`/`KeyRound`/`PowerOff` em
  `app/dashboard/motoristas/page.tsx`). Tudo auditado (padrão `registrarAuditoria`
  S9) e atrás de permissões novas `motoristas.criar` / `motoristas.credencial`
  (seeds de permissão aditivos, migration 0042+).
- **D-C2 (uuid como chave de atividades)**: token do app motorista passa a carregar
  `entregador_uuid` (resolvido no login via cnpj → ContaMotorista → Entregador
  vinculado). Novas gravações de atividade do motorista (validação de NF, gorjeta,
  etc.) registram o uuid junto às chaves atuais — **aditivo**: coluna
  `entregador_uuid uuid NULL` onde fizer sentido; nada de reescrever chaves
  existentes (cnpj continua funcionando). Correlação no hub por uuid.
- **D-C3 (escopo de ambiente)**: TODO o WS-C é código + migrations do hub aplicadas
  **apenas no hub_homolog_db** (migrations 0042+ idempotentes via migrate.sh).
  Produção (chatmasterveloz, app motorista em produção) **não muda nada** nesta
  feature; o cutover disso é decisão futura do operador com rito de 5 gates.
  As rotas legadas (`routes/motorista.js`, `server.js` upload) só podem ser tocadas
  de forma **aditiva e atrás de condição de ambiente** que em produção fique inerte.
- **D-C4 (tela legada)**: a tela legada `/dashboard/motoristas` **não é removida**
  nesta feature (grupo Movee em produção depende dela). Fica como está; a paridade
  de gestão passa a existir no hub.

**Decisões FECHADAS pelo operador em 2026-07-12 (a pipeline NÃO deve reabri-las):**

- **D-C5 (era Q1) — credencial no hub: SIM.** `ContaMotorista` ganha `senha text
  NULL` (bcrypt) + fluxo de reset idêntico ao legado; o app motorista do
  **hub-homolog** passa a autenticar contra ela. Produção segue na base legada até
  cutover futuro com rito.
- **D-C6 (era Q2) — uuid manual OBRIGATÓRIO.** Criar motorista no hub **exige
  informar o uuid** (o mesmo da planilha de performance): validar formato uuid
  (reusar `uuidValido` de `hub-import-normalizer.js`), unicidade por empresa
  (constraint `UNIQUE (id_empresa, id_externo)` já cobre — mapear 409 amigável).
  **Sem geração automática** e sem merge automático; importação casa SEMPRE e SÓ
  por uuid.
- **D-C7 (era Q3) — seção "Atividades" no detalhe.** O detalhe do motorista no hub
  ganha seção read-only correlacionada por uuid (faturamento, performance,
  validações recentes do app motorista); gravações do app motorista passam a
  carregar o uuid de forma aditiva.

## 3. Fases de execução (ordem obrigatória: A → B → C)

### Fase A — navegação (quick wins)
1. `moduloParaRota` caso especial + testes unit (`lib/hub/module-nav`), ajuste do
   estado ativo no `ModuleNav` e card da home; snapshot/teste de render.
2. `perfil-dialog.tsx` (conteúdo extraído da página de perfil para componente
   compartilhado `PerfilCard`/`PerfilDialog`); AccountMenu abre modal; página passa a
   renderizar o mesmo miolo; testes (abrir modal, trocar senha com sucesso/erro,
   fechar).
3. Smoke: sidebar "Painel Geral" → 200/home ativa; avatar → modal.

### Fase B — combobox de entregador
1. Backend: `GET /faturamento/entregadores` + `GET /performance/entregadores`
   (validação de termo ≥3, escopo `id_empresa`, limite 20, testes de DTO/rota).
2. Front: componente `EntregadorCombobox` compartilhado em `components/hub/`
   (Popover+Command, debounce 300 ms, estados: digitando <3, carregando, vazio,
   erro); integração nas 2 telas substituindo o input de id; testes.
3. Smoke autenticado: buscar 3 letras → selecionar → lista filtra (`total` cai).

### Fase C — motorista canônico (uuid)
1. **Migrations 0042+** (idempotentes): `ContaMotorista.senha text NULL` (D-C5);
   permissões novas `motoristas.criar`/`motoristas.credencial` + grants aos papéis
   admin (seed aditivo); NADA de alterar `Entregador` (uuid já existe).
2. **Backend hub**: expor `idExterno` (uuid) em `mapMotoristaListItem`/
   `mapMotoristaDetalhe`; `POST /motoristas` (criar, **uuid informado obrigatório**,
   D-C6: formato + 409 de duplicidade por empresa);
   `POST /motoristas/:id/credencial` (criar conta+senha inicial ou vincular
   existente), `POST /motoristas/:id/credencial/reset-senha`,
   `PATCH .../credencial` (ativo). Tudo com `requirePermission`, escopo por
   `id_empresa`, auditoria, e 404-fora-do-escopo (padrão Decision 11 do S5).
3. **App motorista (homolog)**: login resolve e embute `entregador_uuid` no token;
   gravações de atividade registram uuid (colunas/aditivos onde aplicável), atrás de
   condição de ambiente inerte em produção (mesmo espírito do `lib/envio-gate.js`).
4. **Front hub**: coluna/campo uuid no detalhe (copiável), fluxos de criar motorista
   e gerir credencial (Dialog/Sheet no idioma F3), seção "Atividades" (Q3).
5. **Testes**: unit backend (dto/validação), vitest front, E2E do fluxo completo no
   hub-homolog (criar motorista → criar credencial → login no app motorista mock →
   atividade correlacionada por uuid → aparece no detalhe).

### Encerramento (toda fase)
- `npx tsc --noEmit`, `npx eslint`, `npx vitest run` (front) e `node --test`
  (backend) verdes; rebuild hub-homolog (backend+frontend) sob rito anti-starvation
  (`DOCKER_BUILDKIT=0 … build --memory=2g`, swap conferido) e smoke autenticado
  (login → POST `/me/entidade` → rotas). Migrations via
  `infra/hub/scripts/migrate.sh -f infra/hub/compose.hub.homolog.yml`.

## 4. Critérios de aceitação

- A1: clicar "Painel Geral" (sidebar e card da home) abre `/hub/dashboard` (200),
  item marcado ativo; nenhum outro módulo muda de rota.
- A2: clicar o avatar → dropdown → "Meu perfil" abre **modal** com nome/e-mail e
  "Trocar senha" funcional; nenhuma navegação; `/hub/dashboard/perfil` continua 200.
- B1: no faturamento, digitar ≥3 letras lista motoristas da empresa por nome;
  selecionar filtra a tabela e os cards; limpar remove o filtro; contradição com
  "sem entregador" continua bloqueada; espelhado em performance.
- C1: hub lista/exibe o uuid do motorista; criar/editar/credencial funcionam com
  permissão e auditoria; app motorista (homolog) autentica e o token carrega o uuid;
  atividade nova é correlacionável por uuid no detalhe do hub; produção permanece
  byte-a-byte inalterada (nenhuma env nova definida = comportamento idêntico).

## 5. Restrições operacionais (inegociáveis)

- Cláusula pétrea: nada de produção; somente recursos `hub-*` no VPSTodo (exceção
  standing G1). DDL apenas no `hub_homolog_db` via migrations idempotentes 0042+.
- Builds sempre com rito anti-starvation. Limpeza docker sempre com filtro `hub_*`.
- Commit/push/PR ao final de cada fase **só com autorização** do operador (a
  pipeline prepara a branch e para).
- Não tocar nas imagens/tags de produção nem em `.env` de serviços Swarm.

## 6. Execução via /feature-00c

- Short-name sugerido: `hub-motorista-canonico` (uma feature, 3 workstreams; fases
  A→B→C na criação de tasks; cada fase com review-task).
- **Contexto/memória**: toda sessão de execução usa a skill
  `context-mode:context-mode` (ctx_batch_execute para pesquisa, ctx_search para
  recall) — não ler arquivos crus no contexto principal quando for só análise.
- **Gotchas conhecidos da pipeline** (memória do projeto): `review-task` NUNCA em
  haiku; `reconcile-wave` promove `concluida` cedo demais — verificar entregáveis
  reais antes de avançar o ponteiro; guardar o ponteiro após cada onda.
- **Ao final**: rodar `/code-review` (nível alto) sobre o diff acumulado da branch,
  corrigir achados confirmados e só então declarar pronto para PR.
- Branch: `feat/hub-motorista-canonico` a partir da `main` (que já contém a pilha
  UX/UI #69–#72).

## 7. Referências de código (âncoras para a pipeline)

- `frontend_v2/lib/hub/module-nav.ts` (moduloParaRota, ICON_MAP)
- `frontend_v2/components/hub/account-menu.tsx` · `app/hub/dashboard/perfil/page.tsx`
- `frontend_v2/app/hub/dashboard/page.tsx` (cards da home)
- `frontend_v2/app/hub/dashboard/faturamento/page.tsx:456` (filtro id) ·
  `routes/hub-faturamento.js:109` (filtro backend) · idem performance
- `components/hub/motorista-detalhe-dialog.tsx` (idioma de modal) ·
  admin `EntidadeCombobox` (idioma Popover+Command)
- `infra/hub/migrations/0010_entregador.sql` · `0021_conta_motorista.sql` ·
  `0024_areas_por_entregador.sql` · `0033/0034` (schema legado no banco do hub)
- `backend/lib/hub-import-processor.js:304-340` (upsert Entregador por uuid)
- `backend/routes/hub-motoristas.js` (rotas, allowlist PATCH, vínculo, auditoria)
- `backend/routes/motorista.js` (app motorista legado: login, rate-limit, tokens)
- `app_homologacao/frontend_v2/app/dashboard/motoristas/page.tsx` (tela legada —
  paridade de ações a reproduzir no hub)
