# Briefing de entrada — `/feature-00c adiantamento-motorista` (Etapa B)

> **Aprovado pelo operador em 2026-09-17:** plano, protótipo e propostas Q-N. A Etapa B
> roda com **`/feature-00c`** (família `agente-00c`, orquestrador
> `agente-00c-feature-orchestrator`). O `/agente-00c` foi descartado porque:
> - o `state-rw.sh init` recusa quando já existe `.claude/agente-00c-state/state.db`
>   (execução push-motorista, concluída);
> - com a raiz da sessão como alvo, ele gravaria em `docs/specs/envioMassa_homologacao/`,
>   que está versionado.
>
> **Fontes de verdade, nesta ordem:**
> 1. este briefing;
> 2. [`PLANO.md`](PLANO.md) (decisões D-01..D-22 na §1, propostas Q-N aprovadas na §9.2);
> 3. o protótipo [`prototipo/index.html`](prototipo/index.html);
> 4. `CLAUDE.md` e `docs/constitution.md` (v1.1.0).
>
> ⚠️ **`docs/briefing.md` é o briefing da frente push-motorista.** Ele só existe para
> satisfazer o pré-requisito do comando e **não** descreve esta feature. Na dúvida,
> vale o PLANO.

## 1. Problema (medido, não suposto)

- **Hoje o adiantamento é pedido por um Typebot:**
  - regra fixa em código: terça a sábado, 09h–15h (na prática aceita até 15:59);
  - aceite por texto;
  - Google Forms;
  - cálculo e pagamento manuais.
- **Não existe no sistema:**
  - produção D-1 por motorista;
  - dados bancários;
  - histórico de notificações do motorista (o aviso só é visível para quem ativou push);
  - lote de pagamento;
  - exportação Excel.
- **O financeiro monta à mão a planilha da Transfeera.** O layout de 12 colunas está no PLANO §6–§7 e foi conferido contra o modelo público oficial.

## 2. O que já foi feito (não refazer)

- **Discovery completo** do app motorista, do backend e do hub: PLANO §2.
- **Análise do Typebot:** PLANO §3–§4.
- **Análise das planilhas** (só estrutura, sem dados pessoais): PLANO §5–§6.
- **Prova técnica:** o `xlsx` (SheetJS CE 0.18.5) **já instalado** grava o layout — aba `Página1`, mescla `A1:L1`, texto preservando `033`/`0001`/`0012345`/`0` e moeda `"R$" #,##0.00` (PLANO §15.1). **Não adicionar dependência para isso.**
- **Arquitetura, modelo de dados, estados, APIs, permissões, auditoria e testes:** PLANO §10–§26.
- **O protótipo é o contrato visual** das telas M01–M16 (app) e H01–H15 (hub).

## 3. Escopo desta execução

**Entra — fases do PLANO §27:**

| Fase | Conteúdo |
|---|---|
| F0 | preparação |
| F1 | migrations `0066+` |
| F2 | libs puras |
| F3 | backend do app |
| F4 | backend do hub |
| F5 | notificações |
| F6 | UI do app |
| F7 | UI do hub |
| F8 | script de carga inicial (implementar e testar; **não** rodar em produção) |
| F10 | verificação em `hub-test`/`hub-homolog` |

**Não entra:**

| Item | Motivo |
|---|---|
| **F9** (importador de retorno) | Bloqueado pela Q-B1, o arquivo real que o operador vai enviar. Registrar como bloqueio humano, sem inventar layout. A confirmação **manual** por lote (§14.1 passo 6) **entra**. |
| **F11/F12** (commit, PR, merge, build, deploy, go-live) | Sessão pai + operador, com autorização por etapa. |
| Validações V-1..V-6 na Transfeera | O operador executa. |
| Achados fora do escopo (PLANO §29) | Exceções: itens 2 e 4, que entram por Q-N16 (sessão do app ao abrir; ler `{erro}` no `api-client`), e a acessibilidade **nas telas tocadas**. |

## 4. Restrições (não negociáveis)

1. **Produção é intocável.** Não acessar `chatmasterveloz`, os serviços `envio-massa-homologacao_*`, os domínios `moveelog`, `.env` de produção nem o Traefik. Migrations e stacks **só** em `hub-test-*`/`hub-homolog` (exceção `hub-*` do CLAUDE.md).
2. **Nenhum commit, push, PR ou troca de branch.** Atomic-commit está desligado. O hook `commit-msg` recusa `chore(agente-00c)`. O robô EntreGô executa o diretório vivo: **não mexer em `infra/robo-entrego/`**.
3. **Ancorar todo comando com `cd /var/lib/envioMassa_homologacao`**. O diretório de trabalho persiste e a guarda `session-scope` recusa se ele divergir.
4. **Disco e memória antes de qualquer build ou driver:**
   - `df -h /` — **parar abaixo de 20 GB** (hoje há 23 GB);
   - swap ativa;
   - `docker build --memory=2g`.
   - Limpeza, só `docker builder prune -f`/`docker image prune -f` **sem `-a`**, e só se o operador autorizar. Nunca `--volumes`.
5. **Migrations:** a série única é `infra/hub/migrations/`. A próxima é `0066`. Idempotentes. Nunca editar migration aplicada. Aplicar com `infra/hub/scripts/migrate.sh`.
6. **Dinheiro:**
   - `numeric` no banco;
   - cálculo em SQL (`round` meio para cima);
   - valores como string decimal nas APIs;
   - fuso **explícito** (`America/Sao_Paulo` da configuração) — o container roda em UTC.
7. **Dados pessoais:**
   - nenhum nome, CPF ou conta real em código, teste, fixture, log ou auditoria;
   - `modelo_transfeera.xlsx` e `conta_bancária_drivers.xlsx` **nunca** entram no git;
   - a fixture de contrato é **sanitizada** (aba, linha 1, cabeçalhos e mescla).
8. **E2E e Playwright só pelos drivers** `infra/hub/testes/*.sh`, nunca no host. Depois de cada E2E, **reverter o `package-lock.json`** reescrito pelo container.
9. **Base UI, não Radix:** `Select` exige `items`. Não colocar comentário JSX `{/* */}` logo após `return (`.
10. **Estado de sessão:** o entregador é resolvido no servidor a cada requisição; nunca depender de claim que o `/refresh` descarte.
11. **Não contornar guardas nem classificador:** em bloqueio, parar e registrar bloqueio humano.

## 5. Critérios de aceite (resumo; detalhe na coluna de cada fase do PLANO §27)

- **Regras da §8** (R-01..R-18) implementadas e testadas, incluindo as fronteiras `08:59:59 ✗ · 09:00:00 ✓ · 14:59:59 ✓ · 15:00:00 ✗`.
- **Contrato Excel (§7, §15):**
  - teste relê o arquivo gerado e confere aba, linha 1, 12 cabeçalhos na ordem, mescla, tipos de célula, zeros, soma, quantidade e IDs únicos;
  - o validador roda **antes** de liberar o download.
- **Anti-duplicidade (§14.2)** provada com **concorrência real** no driver de integração: duas criações de lote simultâneas e duas solicitações simultâneas.
- **Os 28 edge cases da §25** cobertos, cada um com o teste indicado.
- **Permissões (§21):**
  - as 10 permissões `adiantamentos.*`, o papel `financeiro` e o módulo `adiantamentos` (ordem 35) criados;
  - rótulos pt-BR (o teste `rotulo-permissao` passa).
- **Auditoria (§22)** sem dados pessoais (`scan-auditoria-sensivel.sh` verde).
- **UI** conforme o protótipo; axe ≥ 95; contraste AA nos dois temas; impeccable com 0 achados nas telas novas; larguras nomeadas.
- **Gates relatados com números:**
  - `tsc`;
  - `npm test` (backend e apps);
  - `test:hub:unit`;
  - driver de integração novo;
  - `next build` do `frontend_v2` e do `frontend_motorista`;
  - lint contra a baseline;
  - baselines herdadas: integração 11/13 e `rls-importacoes` 15/3.
- **README do backend** atualizado com as rotas novas (constitution §III).

## 6. Enganos conhecidos que custaram tempo em frentes anteriores

- **Relatórios de onda já erraram contagem e git.** Conferir sempre por conta própria, por exemplo `grep -cE '^PASS'`; a linha `PREFLIGHT` não é teste.
- **`reconcile-wave` promove `execute-task → review-task` cedo.** Guardar o ponteiro depois de cada onda.
- **`.env.hub.test` tem `POSTGREST_API_KEY` ≠ `PGRST_JWT_SECRET`.** Rotas que dependem disso viram 403 no stack de teste.
- **Tela de E2E vazia aprova contraste falsamente.** Semear dados antes de medir.
- **Sondar rota POST-only com GET dá 404**, que parece "rota ausente".
- **O E2E não rebuilda o frontend do `hub-homolog`.**
