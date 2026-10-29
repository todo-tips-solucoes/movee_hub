# Project Briefing: o repasse gera o movimento no Envio em Massa

> Frente corrente, aberta em 2026-10-28. Detalhe, decisões e medições em
> `docs/plans/repasse-gera-movimento/BRIEFING.md`.

## 1. Visão e Propósito

A frente anterior (`lancamento-externo`) está em produção, validada com dinheiro real, e
**sem efeito**: a dedução dos valores pagos por fora só acontece no **fechamento da
apuração**, e essa operação nunca fechou uma apuração na história do sistema — ela paga
por **planilha** no Envio em Massa.

Esta frente liga a dedução ao caminho que a operação de fato usa: o repasse passa a
**preencher o Envio em Massa**, gerando o movimento com o valor da nota já líquido.

Pedido do operador (28/10): *"ao invés de fechar a planilha, o financeiro deve gerar
movimento para o recebimento de nota na tela de envioemmassa, inserindo valor para a
emissão da nota do motorista. o fluxo depois disso deve funcionar como já funciona hoje.
a única alteração é a forma como o envio em massa é preenchido."*

### 🟢 O mecanismo já existe — é desacoplamento, não construção

`backend/lib/adiantamento-geracao-movimento.js` já decide quem vira movimento e monta a
linha; `routes/hub-adiantamentos.js:2177` já grava na `EnvioMassa` com idempotência; o
botão "Gerar notas da semana" já está na tela. **Três pontos travam:**

1. `routes/hub-adiantamentos.js:2193` — recusa com `APURACAO_NAO_FECHADA`
2. `frontend_v2/.../repasse/page.tsx:251` — botão bloqueado por `periodoAberto`
3. `frontend_v2/.../repasse/page.tsx:239` — botão manual "Fechar apuração", que sai

## 2. Usuários e Stakeholders

| Quem | Como usa |
|---|---|
| **Financeiro** | Confere a prévia do repasse e clica em gerar; as linhas aparecem no Envio em Massa com o valor da nota. Já tem a permissão `adiantamentos.pagamento_confirmar` |
| **Motorista** | Efeito final: recebe a mensagem e emite nota pelo valor líquido do que já recebeu por fora, em vez de receber duas vezes |

## 3. Escopo

### MVP (essencial)

1. A rota de geração **fecha a apuração se ela não existir**, na mesma transação.
2. A dedução do pago por fora sai da **parte da nota**; o excedente vira **saldo** para a
   semana seguinte.
3. **Recusa com diagnóstico** (quantos, status, nomes) quando há adiantamento pendente.
4. Botão Gerar sem exigir período fechado; botão "Fechar apuração" manual **removido**.
5. Botão **"Gerar do repasse"** também na tela de Envio em Massa.
6. Ajuda atualizada nas duas centrais.

### Fora de Escopo

- Qualquer mudança **depois** do movimento criado: disparo, emissão, validação de XML e
  "Fechar movimento" seguem exatamente como hoje.
- O upload de planilha do Envio em Massa.
- Botão de desfazer a geração — a correção é pela tela de Envio em Massa, que já permite
  editar com motivo ou apagar.
- O app do motorista (a parcela "pago por fora" no extrato já está em produção).

## 4. Prioridades e Trade-offs

**O caminho do dinheiro manda.** A entrega toca a rota que cria movimento que gera nota
fiscal. O trade-off aceito: fechar a apuração **automaticamente** (em vez de pedir ao
operador) para preservar o retrato imutável e o saldo transportado que já funcionam, ao
custo de a apuração passar a existir sem ninguém a ter pedido explicitamente.

## 5. Restrições

### Medido no código, não suposto

- `ApuracaoRepasse` tem **0 linhas** em 2026-10-28; `LancamentoExterno`, **0**.
- **116** adiantamentos pendentes na semana 19–25/10 (50 `LIBERADA`, 66 `EXPORTADA`) —
  com a decisão D5, eles **recusam** a geração até serem resolvidos.
- A divisão `valor_nota` / `valor_fora_nota` vem da config `categorias_nota`; quando ela
  é nula, os dois campos vêm nulos e o motivo `SEM_DIVISAO` já existe.
- ⚠️ A `EnvioMassa` **não tem RLS alguma** — o filtro de `id_empresa` na query é a única
  proteção de tenant.
- ⚠️ `hub_adiantamento_repasse` depende da claim de escopo do JWT: consulta sem ela
  devolve **zero linhas** e parece defeito.
- ⚠️ `mensagem1_modelo` é **NULL** nas empresas do `hub_homolog` — teste do caminho feliz
  exige fixture própria.

### Técnicas

- Node 20 + Express sem ORM; PostgREST com `SECURITY DEFINER` e `REVOKE` antes do `GRANT`.
- `express.json()` global de 100 KB roda antes do router — parser vai na rota.
- Migration nova só se necessária; se houver, série `infra/hub/migrations/NNNN_*.sql`,
  **nunca** editar migration aplicada.

## 6. Stack Técnica

Node 20 + Express · PostgreSQL via PostgREST · Next.js 16 App Router + React ·
Tailwind 4 + Base UI + shadcn · `node --test` (backend), **vitest** (frontend_v2),
**Playwright** (E2E do hub).

Skills de consulta: `postgresql` / `postgres-best-practices`, `nodejs-backend-patterns`,
`nextjs-app-router-patterns`, `tailwind-patterns`, `vitest-skill`, `typescript-pro`.

## 7. Qualidade e Padrões

- **Deduplicação acima de tudo**: o mecanismo existe. Procurar antes de escrever;
  reusar `planejarGeracao`, os `MOTIVOS` e a trilha de idempotência, não reimplementar.
- **Preferir restringir a generalizar** — na frente anterior, 4 de 15 correções criaram
  defeito novo, e as duas mais elegantes foram as mais caras.
- **Controle negativo obrigatório** em cada correção, com testes **nomeados** e a prova de
  que a reversão foi aplicada **antes** de medir.
- **Teste que passa com e sem a mudança é achado**, não cobertura.
- **Gates com números**: backend `node --test`, `tsc`, vitest, lint contra a baseline, e
  os drivers de integração do hub.

## 8. Visão de Futuro

Com o repasse preenchendo o Envio em Massa, a planilha deixa de ser o único caminho e a
dedução automática passa a alcançar o fluxo real. O fechamento manual da apuração fica
disponível no código para quem um dia precisar do retrato sem gerar nota.

## Itens a Definir

**Nenhum.** As 12 decisões de desenho foram tomadas pelo operador antes do início, para
que o desenvolvimento corra sem interrupção — a lista completa está na §4 de
`docs/plans/repasse-gera-movimento/BRIEFING.md`.
