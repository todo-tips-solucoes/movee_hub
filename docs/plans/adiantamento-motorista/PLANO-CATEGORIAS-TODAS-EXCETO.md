# Categorias do adiantamento: modo "Todas, exceto as marcadas"

> Status: **APROVADO pelo operador em 24/11/2026** (telas 1–2, C1–C6, modo nas 3 listas). Deploy autorizado ao finalizar. Telas no canvas
> [Categorias do adiantamento](https://claude.ai/artifact/EJJc6hhc483knqLsu4C9Gn).
>
> **Origem:** mensagem da equipe (24/11/2026): "as novas categorias não contabilizam no
> faturamento para antecipação… tem como deixar o faturamento completo mesmo que entre com uma
> categoria diferente dia a dia no relatório?"
>
> **Rito:** o mesmo do [PLANO-MELHOR-EXTRATO](../campanhas-motorista/PLANO-MELHOR-EXTRATO.md).
> Decidir tudo aqui (Opus) e executar com o plano fechado (Sonnet).
>
> **Pilares:** deduplicação · escalabilidade · segurança · performance.

## 1. Medido antes de propor (produção, empresa 6, somente leitura, 24/11)

| Fato | Número | Consequência |
|---|---|---|
| Configuração vigente | **versão 28, salva em 23/11**, com 30 categorias marcadas, inclusive categorias de um dia só ("APR - JANTAR LIVRE 13/11 FRANQUIA", "Sua bag iFood trouxe grana a mais") | A equipe acompanha as categorias **na mão**, e é esse trabalho que quer eliminar. |
| Categorias novas | **1 a 8 por semana** (90 dias). Cerca de metade casa com a família "Promoção - …" e entra sozinha. A outra metade (`PROMOTION_FRANCHISE`, "Incentivo chuva - mes de outubro", "Rotas Consecutivas Franquias"…) fica fora até alguém marcar. | Entre aparecer e ser marcada, a categoria não conta para a antecipação. |
| O que está fora hoje | Só as 3 categorias **"Percentual atingido de …"** (rotas completas, hora online, garantido): **15 a 20% do crédito de cada semana** (R$ 116 mil a R$ 145 mil) | Segundo o operador, **são indicadores, não dinheiro do entregador**, e precisam continuar fora (decisão Y1). |
| Débitos | 1 categoria em 60 dias | A produção já soma só créditos. Nada muda. |
| Por onde passa a regra | Todo cálculo que filtra categoria (produção do adiantamento, extrato e nota do repasse, apuração, campanha extrato) chama **uma** função: `hub_adiantamento_categoria_casa(descricao, lista)` (0087) | A mudança vai **numa função só**, e todos os chamadores a herdam (deduplicação). |

**Onde a informação já aparece hoje:** em Adiantamentos › Configurações, nos 3 seletores de
categoria (produção, extrato do repasse, "dessas, quais entram na nota"). É o mesmo
componente, `components/hub/seletor-categorias.tsx`, também usado na campanha "Melhor
extrato". **Não há tela nova nem rótulo novo para dado que já existe.** O seletor ganha só a
escolha "Como contar" e um aviso.

## 2. Decisões do operador (24/11)

- **Y1.** "Percentual atingido de …" é indicador. Continua fora da antecipação.
- **Y2.** A solução é um **modo novo no seletor que já existe**, sem rotina automática e sem filtro paralelo. Vem com a proteção para indicadores e o aviso de categorias novas.

## 3. Propostas para aprovar junto com as telas

| # | Proposta | Por quê |
|---|---|---|
| C1 | Cada seletor ganha **"Como contar"**: "Só as marcadas" (o de hoje, que continua o **padrão**) ou "Todas, exceto as marcadas". No segundo modo, as categorias marcadas são **exceções**. | Categoria nova entra sozinha a partir da 1ª importação, sem job. |
| C2 | O modo vale **por lista**, nas 3 listas da tela (produção, extrato, nota). Cada uma escolhe o seu. | O componente é um só. O operador pode vetar e deixar só na produção. |
| C3 | Nova família **"Indicadores"** (`familia:indicador`): o nome começa com "Percentual atingido". Ao trocar para "Todas, exceto", ela já vem **marcada como exceção**, mas pode ser desmarcada. Como é família, um indicador novo com esse padrão de nome também fica fora sozinho. | Protege a Y1 contra os indicadores que surgirem depois (fail-closed: o valor antecipado não sobe sem querer). |
| C4 | **Aviso de categorias novas desde a última revisão.** "Última revisão" é a data da versão vigente da configuração (`vigente_desde`), então salvar marca a revisão. "Nova" é a categoria cujo 1º lançamento, dentro da janela de 90 dias que a tela já usa, é posterior a essa data. No modo "todas" o aviso é azul ("já estão entrando… marque como exceção se não for dinheiro do entregador"). No modo "marcadas" é âmbar ("estão FORA da antecipação"). | A equipe confere o que entrou sem caçar. No modo de hoje, o aviso já resolve o "ficou de fora sem ninguém ver". |
| C5 | O detalhe da solicitação no hub mostra o modo e as exceções que valeram no cálculo, porque o snapshot salvo traz os tokens. Nunca mostra o token cru. | Auditoria: a regra que calculou cada adiantamento continua legível. |
| C6 | **A campanha "Melhor extrato" não ganha o modo** (fora do escopo). Ela passa a aceitar a família "Indicadores", porque o seletor dela é o mesmo e vai mostrar a família. | Sem surpresa na tela da campanha. |

## 4. Modelo de dados (migration `0131`, aditiva e idempotente, sem coluna nova)

O modo vive **na própria lista**, como um token, igual às famílias da 0087:

```
categorias_* = ['modo:todas', 'familia:indicador', 'Gorjeta']
  → todas as categorias, EXCETO os indicadores e a Gorjeta
categorias_* = ['Corridas concluidas', 'familia:promocao']
  → só essas (como hoje; nada muda para as listas existentes)
```

```sql
hub_adiantamento_categoria_familia(d)   -- + WHEN d ~* '^percentual atingido' THEN 'familia:indicador'
hub_adiantamento_categoria_casa(d, p) =
  CASE WHEN 'modo:todas' = ANY(p)
       THEN NOT (d = ANY(p) OR familia(d) = ANY(p))  -- exceções
       ELSE      d = ANY(p) OR familia(d) = ANY(p)   -- como hoje
  END  (NULL/vazio → false, como hoje)
```

- **Por que token e não coluna:** são mais de 15 chamadores em 10 migrations, e todos passam a lista para `casa()`. Com token, só `casa()` muda. Com coluna, cada chamador teria de ser redefinido para passar o modo (diff grande, risco de esquecer um). Token já é o padrão da casa (`familia:*`).
- **Validação no banco** (`hub_adiantamento_configuracao_salvar` e CHECK das 3 colunas):
  - token `modo:` só pode ser `modo:todas`, no máximo uma vez;
  - token `familia:` precisa estar em `{promocao, missoes, indicador}`;
  - token desconhecido é **recusado**, porque no modo "todas" uma exceção com erro de digitação faria contar dinheiro que não devia.
- **Lista de famílias em um lugar só no banco:** `hub_adiantamento_familias()` → `text[]`, usada pela validação do adiantamento **e** pela `hub_campanha_categorias_ok` da 0129. Hoje a 0129 repete `promocao`/`missoes`; passa a ler da função. A campanha recusa `modo:`.
- **`hub_adiantamento_categorias()` e `hub_campanha_categorias()`** ganham a coluna `primeira date` (min `data_referencia` na janela). Como o retorno muda, é DROP + CREATE, com os GRANTs repetidos.
- **Snapshot:** a solicitação já grava `categorias_producao` como estava no cálculo. Com o token, o histórico continua exato.

## 5. Aplicação (backend e telas)

- **Backend:** `lib/adiantamento-dto.js` valida os tokens com as mesmas regras (defesa em profundidade) e passa `primeira` adiante. `lib/campanha-dto.js` aceita `familia:indicador` e recusa `modo:`.
- **Hub:**
  - `SeletorCategorias` ganha a prop opcional `modo` (sem ela, a campanha continua igual);
  - a regra de casamento no cliente vira **uma** função TS `casaCategoria(descricao, familia, lista)`, espelho de `casa()`, testada com a mesma tabela de casos do driver de banco. É usada por `restringirAoExtrato`, que no modo "todas" do extrato oferece à nota tudo menos as exceções, pela contagem "N de M entram" e pelo aviso;
  - `ROTULO_FAMILIA` ganha "Indicadores";
  - o detalhe da solicitação traduz os tokens.
- **App motorista:** nada muda. O valor dele sai do mesmo cálculo.

## 6. Pilares, verificáveis

- **Deduplicação:**
  - uma função de casamento no banco (`casa`) e o espelho no cliente, com tabela de casos compartilhada;
  - uma lista de famílias no banco;
  - o mesmo componente nas 4 telas.
- **Escalabilidade:** nenhum job e nenhuma coluna nova. A regra continua inlinável (`LANGUAGE sql IMMUTABLE`).
- **Segurança:**
  - token desconhecido recusado no banco e no DTO;
  - indicadores fail-closed (C3);
  - RLS e GRANT inalterados;
  - gate `owasp-security` antes do PR.
- **Performance:**
  - produção do adiantamento e prévia do repasse medidas antes e depois no hub-test, com o volume do driver de performance. Orçamento: **regressão ≤ 10%**;
  - `hub_adiantamento_categorias` ≤ 500 ms, como na campanha.

## 7. Rollback (atenção)

Voltar só a imagem é seguro. **Desfazer a `0131` com alguma lista em `modo:todas` salva é
perigoso:** a `casa()` antiga leria `modo:todas` como nome de categoria, e as exceções
virariam as únicas categorias que contam. Por isso:
1. o roteiro de rollback do banco primeiro **recusa** desfazer enquanto houver lista com `modo:`;
2. o operador volta essas listas para "Só as marcadas" pela tela;
3. só então desfaz.

O roteiro de deploy traz esse script pronto.

## 8. Execução (depois da aprovação)

Worktree `.claude/worktrees/categorias-todas`, branch `feat/adiantamento-categorias-todas-exceto`. Execução em Sonnet.

| Onda | Agente | Entrega | Gate |
|---|---|---|---|
| W1 | `database-architect` | 0131 (família, `casa`, validação, `familias()`, `primeira`, campanha) | `hub-adiantamentos-integration.sh` e `hub-campanhas-db.sh` verdes, com casos novos: modo todas/marcadas × nome/família × lista vazia/NULL × token desconhecido; nota ⊂ extrato no modo todas; snapshot; controle negativo com guarda anti-oco; performance medida |
| W2 ∥ W3 | `fullstack-developer` ×2 | backend (DTOs) · hub (seletor, `casaCategoria`, aviso, detalhe) | `npm test`, `test:hub:unit`; `tsc` 0, vitest, lint ≤ baseline, impeccable 0, `next build` |
| W4 | `fullstack-developer` | E2E das Configurações: trocar o modo, exceção, aviso de novas, salvar, prévia muda | driver de adiantamentos verde (ele rebuilda: guarda de 21 GiB) |
| W5 | revisão independente (`owasp-security` + correção) | achados | cada um **medido** antes de aceitar |
| W6 | Opus | PR, merge, build `<rótulo>-<sha7>`, 0131, deploy, prova de bundle | rito git + 5 gates |

## 9. Pendências do operador

1. Aprovar as telas 1 e 2 e as propostas C1 a C6 (em especial a **C2**: o modo nas 3 listas ou só na produção).
2. Janela de deploy (gate 2).

## 10. Fora do escopo, de propósito

- Rotina que marca categorias sozinha (a Y2 escolheu o modo).
- O modo "todas" na campanha "Melhor extrato".
- Recalcular adiantamentos já solicitados (o snapshot é imutável, como hoje).
- Débitos na produção.
