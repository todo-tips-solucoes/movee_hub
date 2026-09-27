# Runbook de deploy — F1: identificador do motorista no repasse

> ⚠️ **HISTÓRICO — não seguir como runbook de execução.** O operador decidiu
> (2026-09-27, block-010/dec-093) entregar F1+F2+F3 num **PR único e um deploy único**.
> A ordem de deploy e o rollback vigentes estão em
> [`RUNBOOK-DEPLOY.md`](RUNBOOK-DEPLOY.md). Este documento fica só pelo valor histórico
> de "o que muda"/gates/decisões de F1 — **não execute a "Ordem de deploy" abaixo**.

Feature: [`repasse-saldo-minimo`](../../specs/repasse-saldo-minimo/spec.md), FASE 1
(`docs/specs/repasse-saldo-minimo/tasks.md`). **Sem migration, sem pré-condição de
negócio** — F1 só acrescenta um campo de leitura (`Entregador.id_externo`, já
existente na tabela) à tela e ao CSV de Repasse semanal. A execução em produção é
**sempre do operador**, ou do agente só com autorização explícita **por passo**
(uma etapa não autoriza a seguinte), sob os 5 gates de
[`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md).

> **O ambiente chamado "homologação" É produção.** Todo comando aqui atinge
> clientes reais (`app.moveelog.com.br`).

## O que muda

- `GET /api/v1/adiantamentos/repasse` e `GET /api/v1/adiantamentos/repasse/exportar`
  passam a resolver `Entregador.id_externo` (em lotes de 100,
  `lib/hub-postgrest-lotes.js`) e devolver `idExterno` em cada item.
- Tela `app/hub/dashboard/adiantamentos/repasse/page.tsx`: coluna nova
  "Identificador" com `CopyableUuid` (mesmo componente/rótulo da tela de
  Motoristas — FR-003).
- CSV exportado: cabeçalho ganha a coluna `Identificador` **como primeira
  coluna** — `Identificador,Entregador,Créditos,Adiantamentos,Débitos,Remanescente`.
  ⚠️ **Quebra leitura por posição** de quem consome o CSV hoje (financeiro) —
  avisar antes do deploy (tasks.md 1.3.5).
- Falha ao resolver `id_externo` (lote do PostgREST ou id sem correspondência)
  responde `502 { erro: 'ERRO_SERVIDOR' }` nas duas rotas — nunca uma linha sem
  identificador (FR-003, contracts/hub-repasse-api.md).

Sem DDL: nenhuma migration, nenhuma alteração de schema ou de permissão.

## Gates do rito do ciclo git (antes do PR — CLAUDE.md "Rito do ciclo git")

Atualizado na onda-016 (2026-09-27) — suíte completa, sem restrição de memória
(RAM disponível ~7 GB no momento da medição):

| Gate | Comando | Resultado |
|---|---|---|
| Types | `npx tsc --noEmit` (frontend_v2 e frontend_motorista) | 0 erros nos dois |
| `npm test` completo (backend) | `npm test` | 1622/1622 pass, 0 fail |
| `npx vitest run` completo (frontend_v2) | `npm test` | 778/778 pass (86 arquivos) |
| `npm test` completo (frontend_motorista) | `npm test` | 105/105 pass |
| `next build` (frontend_v2) | `npm run build` | sucesso, 0 erros |
| `next build` (frontend_motorista) | `npm run build` | sucesso, 0 erros |
| Lint vs. baseline (frontend_v2) | `npm run lint` | 5 erros/23 warnings, **todos pré-existentes** em arquivos não tocados por esta feature (confirmado via `git diff main` vazio nesses arquivos) + 1 warning pré-existente em arquivo tocado (mesma linha já em `main`) — 0 novo |
| Lint (frontend_motorista) | `npm run lint` | sem `eslint.config.js` — gap pré-existente em `main`, fora do escopo desta feature |

Nota: os números acima cobrem a feature inteira (F1+F2+F3), não só os arquivos
de F1 — rodados juntos porque a branch `feat/repasse-saldo-minimo` entrega as
três fases num PR só (ver tasks.md FASE 1/2/3).

## Prova de bundle (CLAUDE.md "Prova")

HTTP 200 não prova que o código novo está no ar. Depois do deploy do
`frontend_v2`, buscar no bundle servido uma string que só existe nesta
entrega — ex.: o texto do cabeçalho `Identificador` no chunk da rota
`/hub/dashboard/adiantamentos/repasse`, ou o campo `idExterno` na resposta
JSON de `GET /api/v1/adiantamentos/repasse` (curl autenticado, sem expor
cookies/token em log).

## Os 5 gates de produção

1. **Autorização explícita** do operador para este deploy específico.
2. **Janela combinada** — fora do horário de fechamento de apuração e das
   janelas do robô EntreGô (11h/13h/14h) não é necessário aqui (F1 não toca
   nenhum dos dois), mas evitar pico de uso do painel é prudente.
3. **Plano de rollback**:
   - Anotar a imagem atual ANTES de atualizar:
     `docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'`
   - Rollback = `docker service update --with-registry-auth --image <imagem-anterior> <serviço>`
     (backend e/ou frontend_v2, o que tiver sido atualizado).
   - Sem DDL: nenhum rollback de banco necessário.
4. **Aplicar**: `docker service update --with-registry-auth --image <nova-imagem> <serviço>`.
   **Nunca** `docker stack deploy`.
5. **Smoke test**: `GET /api/v1/adiantamentos/repasse?periodo=<semana atual>`
   autenticado — confirmar `idExterno` presente em cada item; conferir a
   coluna "Identificador" na tela; exportar o CSV e confirmar a primeira
   coluna.

## Nota para o corpo do PR — aviso ao financeiro (tasks.md 1.3.5)

O corpo do PR **deve incluir**, literalmente, um aviso deste teor (quem lê o
CSV por posição de coluna hoje precisa ajustar antes do deploy):

> ⚠️ **Quebra de compatibilidade no CSV de Repasse semanal** (aba
> Adiantamentos → Repasse → Exportar): a partir deste deploy o cabeçalho
> ganha uma coluna nova, **`Identificador`, como primeira coluna** —
> `Identificador,Entregador,Créditos,Adiantamentos,Débitos,Remanescente`.
> Quem consome esse CSV por **posição** (não por nome de coluna) precisa
> ajustar o script/planilha antes do deploy ir para o ar. Avisar o financeiro
> com antecedência.

## Ordem de deploy

Só backend (as duas rotas) + frontend_v2 (a tela). Nenhuma ordem obrigatória
entre os dois — o backend responde `idExterno` novo, mas a tela antiga ignora
campo desconhecido; a tela nova só quebraria se o backend NÃO tivesse o campo
(por isso, se as duas imagens não puderem subir juntas, o backend vai
primeiro). Sem PostgREST `SIGUSR1` (nenhuma mudança de schema/RPC).

## Referências

- [spec.md](../../specs/repasse-saldo-minimo/spec.md) FR-001..FR-005
- [contracts/hub-repasse-api.md](../../specs/repasse-saldo-minimo/contracts/hub-repasse-api.md)
- [tasks.md](../../specs/repasse-saldo-minimo/tasks.md) FASE 1
