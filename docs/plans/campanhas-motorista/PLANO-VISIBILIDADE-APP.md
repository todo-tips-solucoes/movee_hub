# Campanhas: interruptor de visibilidade no app e só a posição do motorista

> Status: **APROVADO pelo operador em 24/11/2026** (P1–P7). Deploy autorizado ao finalizar. Telas 13 e 14 no canvas
> [Campanhas do Motorista](https://claude.ai/artifact/MZpA1kT3UyvrxvP5ck2PVj).
>
> **Origem:** pedido do operador (24/11/2026).
> 1. Um interruptor para controlar se os motoristas veem a campanha.
> 2. O app mostra só a posição ("8º"), sem o total ("8º de 201").
>
> **Rito:** o mesmo do [PLANO-MELHOR-EXTRATO](PLANO-MELHOR-EXTRATO.md). Pilares: deduplicação · escalabilidade · segurança · performance.

## 1. Onde isto já aparece hoje (lido no código, 24/11)

| Informação | Onde aparece |
|---|---|
| "Nº **de N**" | Topo da tela da campanha de nota (`frontend_motorista/app/(app)/campanhas/[id]/page.tsx:268`) e da campanha extrato (`components/campanha-extrato.tsx:112`). |
| "**entre N** motoristas" | Frase da nota na tela da campanha de nota (`page.tsx:691`). |
| "Nº **de N** motoristas" / "Você ficou em Nº **de N**" | **Card da campanha na tela Início** (`components/card-campanha.tsx:93,109`), em andamento e no resultado. Achado pelo operador na revisão do plano. |
| Total no payload | `totalClassificados` em `GET /motorista/campanhas/:id` (RPC `hub_motorista_campanha`) e `total` em cada item de `GET /motorista/campanhas` (RPC `hub_motorista_campanhas`, um `count(*)` por campanha). |
| O que o motorista vê | **Uma regra só** no banco, `hub_campanha_visivel(c, entregador)` (0127). Valem por ela: a lista do app, o card na Início, o detalhe, os turnos do extrato e a foto do prêmio. |
| Avisos por push | Início: varredura de 60 s `hub_campanhas_avisar_inicio`, que não repete (`aviso_inicio_em`). Fim: `hub_campanha_fechar_interno` (`aviso_fim_em`). |
| Trava pós-lançamento | Gatilho `hub_campanha_imutavel_trg`. Só as colunas da lista `v_livres` mudam depois de lançar. |

Produção hoje: **0 campanhas cadastradas**. Nada muda para quem já usa.

## 2. Decisões do operador (24/11)

- **V1.** O interruptor vale **por campanha**.
- **V2.** Desligado, a campanha **some do app**: lista, card, detalhe e turnos. **Nenhum push** é enviado. Cálculo, ranking e prêmios continuam no hub.
- **V3.** Toda campanha **nasce oculta**, as novas e as que já existem. Hoje não há nenhuma.
- **V4.** O app mostra **só a posição**, "8º".

## 3. Propostas para aprovar junto com as telas

| # | Proposta | Por quê |
|---|---|---|
| P1 | Coluna `Campanha.visivel_app boolean NOT NULL DEFAULT false`, **mutável depois de lançar** (entra em `v_livres`). | V1 e V3. Ligar ou desligar é exibição, não regra da campanha. |
| P2 | `hub_campanha_visivel` ganha `AND c.visivel_app`, numa linha só, e todos os caminhos do app obedecem. | Deduplicação: uma regra, nenhum chamador esquecido. |
| P3 | **Push de início** sai na primeira vez que a campanha está visível dentro do período (`AND visivel_app` na varredura). Campanha oculta nunca dispara push. **Push de fim** só sai se ela estiver visível no fechamento. Se estiver oculta, o fim é marcado como tratado e o aviso não sai depois. | V2. Avisar sobre algo que o motorista não consegue abrir gera chamado. |
| P4 | Interruptor no **detalhe da campanha** no hub, em qualquer situação menos cancelada (tela 13), e no formulário de criar/editar. Selo "Visível no app" / "Oculta no app" no detalhe e numa coluna da lista. Permissão `campanhas.gerir`. | É o lugar onde quem gere a campanha já está. |
| P5 | Cada troca do interruptor vai para a **Auditoria** (quem, quando, de/para), pela RPC nova `hub_campanha_visibilidade(p_id, p_visivel)`, SECURITY DEFINER com a mesma checagem de empresa e permissão das RPCs de campanha. | Segurança: esconder ou mostrar prêmio para a base é ação com dono. |
| P6 | O app mostra só **"8º"** em todo lugar (tela 14): no topo da tela da campanha, nos dois tipos, e no card da Início ("8º" em andamento; "Você ficou em 8º" no resultado). A frase "Nota X entre N motoristas" vira "Nota X". O top 10 continua como está, sem total. | V4: nenhuma referência ao total de motoristas no app. |
| P7 | O total **sai do payload do app**: `totalClassificados` do detalhe e `total` da lista (RPCs e DTO do backend). Um teste afirma a ausência dos dois. O hub continua com os totais. | Segurança e minimização: o que não aparece não trafega. A lista ainda economiza um `count(*)` por campanha. |

## 4. Modelo de dados (migration `0132`, aditiva e idempotente)

```
Campanha + visivel_app boolean NOT NULL DEFAULT false
hub_campanha_imutavel_trg   → v_livres + 'visivel_app'   (redefinido a partir do corpo VIVO)
hub_campanha_visivel        → + AND c.visivel_app
hub_campanhas_avisar_inicio → + AND visivel_app
hub_campanha_fechar_interno → push de fim só se visivel_app (aviso_fim_em marcado de qualquer jeito)
hub_campanha_visibilidade(p_id int, p_visivel boolean) → nova; auditoria
hub_campanha_salvar         → aceita visivelApp no rascunho
hub_campanha_item_json      → + visivelApp
hub_motorista_campanha      → − totalClassificados
hub_motorista_campanhas     → − total (item da lista)
```

Toda função redefinida parte da **definição viva** (0127 → 0129 → 0131), nunca da primeira.

## 5. Pilares, verificáveis

- **Deduplicação:** uma regra de visibilidade (`hub_campanha_visivel`) e um componente de interruptor reaproveitado no detalhe e no formulário. Nenhuma checagem paralela no backend ou no app.
- **Escalabilidade:** uma coluna booleana na linha que a regra já lê. Sem tabela nova, sem job novo.
- **Segurança:**
  - oculta = nada no app, nem push;
  - `totalClassificados` fora do payload;
  - troca auditada;
  - permissão `campanhas.gerir` + empresa ativa;
  - gate `owasp-security` antes do PR.
- **Performance:** orçamento ≤ +5% nas RPCs do app (`hub_motorista_campanhas` e `hub_motorista_campanha`), medido no `hub-campanhas-perf.sh`.

## 6. Execução (depois da aprovação)

Worktree `.claude/worktrees/campanhas-visibilidade`, branch `feat/campanhas-visibilidade-app`. Execução em Sonnet.

| Onda | Agente | Entrega | Gate |
|---|---|---|---|
| W1 | `database-architect` | 0132 | `hub-campanhas-db.sh` com casos novos: oculta some de todos os caminhos do app (lista, detalhe, turnos, foto), push de início só depois de ligar, fim oculto sem push, interruptor mutável depois de lançar e auditado, payload sem `totalClassificados`, empresa errada recusada, regressão; controle negativo com guarda anti-oco; performance |
| W2 ∥ W3a ∥ W3b | `fullstack-developer` ×3 | backend (rota `PATCH /hub/campanhas/:id/visibilidade`, DTOs, app sem total) · hub (interruptor, selo, coluna) · app (só "8º", frase sem "entre N") | `npm test`, `test:hub:unit`; `tsc` 0, testes, lint ≤ baseline, impeccable 0, `next build` ×2 |
| W4 | `fullstack-developer` | E2E: campanha nasce oculta → app não vê → liga → app vê, mostra só "8º", sem total no payload | drivers de campanhas verdes |
| W5 | revisão independente | achados | cada um **medido** antes de aceitar |
| W6 | Opus | PR, merge, build, 0132, deploy, prova de bundle | rito git + 5 gates |

## 7. Pendências do operador

1. Aprovar as telas 13 e 14 e as propostas P1 a P7.
2. Janela de deploy.

## 8. Fora do escopo

- Esconder campanha só para parte do público. O interruptor é tudo ou nada; o público já é definido por praça, turno e modal.
- Agendar a visibilidade (ligar em data futura).
