# Integridade Financeira Checklist: repasse-saldo-minimo (F3 — saldo mínimo carregado)

**Purpose**: validar a qualidade dos requisitos de dinheiro da F3 (retenção abaixo do piso, transporte, conservação, ordem de fechamento, histórico, exibição).
**Created**: 2026-09-26
**Feature**: [spec.md](../spec.md)

## Completude

- [x] CHK001 - A regra de cálculo cobre todos os ramos (remanescente negativo; 0 < total < piso; total ≥ piso; total = 0)? [Completude, Spec §FR-013–FR-015/FR-018/FR-019; research Decision 8] {auto}
- [x] CHK002 - O limite exato do piso (igual ao piso paga) está definido? [Clareza, Spec §FR-015 "igual ou maior"] {auto}
- [x] CHK003 - O transporte vale mesmo sem movimentação na semana seguinte? [Completude, Spec §FR-016; research Decision 10 + controle negativo "R$ 3,00 → semana sem atividade"] {auto}
- [x] CHK004 - Motorista desativado preserva saldo? [Edge Case, Spec §Edge Cases; research Decision 10 "sem filtro de ativo"] {auto}
- [x] CHK005 - Os componentes da nota (valor da nota / fora da nota) do saldo carregado estão especificados, e o pagamento sai numa única nota? [Completude, Spec §FR-020; research Decision 8 (D4)] {auto}
- [x] CHK006 - O saldo preso sem movimento futuro tem destino explícito (fora de escopo, visível, baixa manual pelo rito)? [Completude, Spec §Clarifications, §FR-017] {auto}
- [x] CHK007 - Está especificado QUAL versão do piso (configuração versionada) vale no fechamento e se o valor aplicado fica registrado na apuração para auditoria? [Resolvido, block-006: piso vigente NO MOMENTO DO FECHAMENTO, gravado em `ApuracaoRepasse.piso_aplicado`; Spec §FR-025a; data-model `ApuracaoRepasse`; research Decision 12; contrato hub-repasse-api §POST /fechar; quickstart F3.15] {resolvido}

## Clareza e consistência

- [x] CHK008 - A conservação de valor está expressa como invariante verificável no banco? [Clareza, data-model CHECK `apuracaorepasseitem_saldo_conserva`] {auto}
- [x] CHK009 - "Paga tudo ou retém tudo" (nunca parcial) está explícito? [Clareza, data-model CHECK `valor_pago = 0 OR valor_transportado = 0`] {auto}
- [x] CHK010 - O `total` exibido/devolvido no fechamento é o que será pago, consistente entre rota e diálogo? [Consistência, research Decision 11] {auto}
- [x] CHK011 - O remanescente negativo com saldo anterior mantém a nota da própria semana como hoje (FR-018), sem reduzir o saldo (FR-019)? [Consistência, research Decision 8 último parágrafo] {auto}
- [x] CHK012 - O piso não é exposto como número ao motorista, evitando segundo vocabulário? [Consistência, contracts/motorista-repasse-api.md; CLAUDE.md "Propor UI nova"] {auto}

## Ordem, concorrência e histórico

- [x] CHK013 - Fechamento fora de ordem (anterior ou pulando semana) tem motivo único e a primeira apuração é livre? [Spec §FR-021; research Decision 9 `APURACAO_FORA_DE_ORDEM`] {auto}
- [x] CHK014 - Fechamentos concorrentes da mesma empresa são serializados? [NFR, research Decision 9 `pg_advisory_xact_lock` por empresa] {auto}
- [x] CHK015 - Apurações fechadas antes da regra ficam intocadas e distinguíveis (NULL = pré-regra)? [Spec §FR-022/SC-007; research Decision 7] {auto}
- [x] CHK016 - O rollback da F3 recusa quando já há saldo transportado pós-0098? [Recuperação, plan F3 passo 2] {auto}

## Critérios de aceite e exibição

- [x] CHK017 - SC-005 (nenhum valor perdido) é mensurável por sequência de semanas simuladas com controle negativo? [Mensurabilidade, plan F3 passo 3 — driver + `0098-saldo-minimo.test.sql`, 9 casos + controles negativos] {auto}
- [x] CHK018 - Na tela/CSV do financeiro o retido aparece com "a pagar = 0", nunca omitido? [Spec §FR-024; plan F3 passo 4/6] {auto}
- [x] CHK019 - O motorista vê o retido na semana em curso E na semana fechada? [Spec §FR-023; contrato motorista: `abaixoDoMinimo` + `ultimoFechado.retido/transportado`] {auto}
- [x] CHK020 - O texto e a posição do aviso de retenção no app do motorista estão aprovados, depois do levantamento de onde cada número já aparece (repasse, home, movimento)? [Ambiguity, contrato motorista "[PROPOSTA]"; plan F3 passo 7] {humano} — aprovado pelo operador (block-007/dec-047, 2026-09-26); termo "Retido" saiu de toda UI visível
- [x] CHK021 - A F3 entra no ar antes do primeiro fechamento real de produção (janela combinada)? [Resolvido, block-006: operador confirmou que segura o botão "Fechar apuração" em produção até a F3 estar implantada; plan.md "Pré-condição operacional confirmada"] {resolvido}
- [x] CHK022 - Quando `remanescente<0` E há `saldo_anterior>0` (não só a nota da própria semana, mas a divisão nota/fora do valor TRANSPORTADO), a produção nota-elegível desta semana deveria compor a nota futura ou é descartada, como sempre foi para semanas negativas antes da F3 existir? [Gap achado na revisão adversarial 3.9.1, `migrations/0098_repasse_saldo_minimo.sql:276-289`; distinto de CHK011 (que cobre só o valor em dinheiro, já correto)] {humano} — resolvido pelo operador (block-008/dec-055, 2026-09-27): nenhuma das duas opções da pergunta original — a produção nota-elegível NÃO compõe a nota futura (o saldo antigo transportado segue intocado, `transportado_nota/_fora = saldo_anterior_nota/_fora`, SQL inalterado) e NÃO é descartada: ela vira a nota da PRÓPRIA semana negativa, exatamente como qualquer semana negativa sem saldo já fazia. Corrigido em `lib/adiantamento-geracao-movimento.js` (o `retido` só se aplica com `remanescente>=0`, alinhando com a fórmula já documentada em data-model.md/research.md Decision 8) — a assimetria era só na implementação; o design já estava certo

## Notes

- CHK007 foi resolvido nesta rodada (block-006): a spec ganhou FR-025a, não sobra `[Gap]` para virar tarefa de requisito em `create-tasks` — `create-tasks` implementa FR-025a como qualquer outro FR da F3.
- CHK020 é decisão sobre o que o motorista vê: bloqueio humano antes de implementar a UI do app (F3 passo 7), não antes das tarefas — não bloqueia `create-tasks`.
- CHK021 resolvido por pré-condição operacional (ordem de deploy), não por mudança de requisito — nada novo para `create-tasks` além do já previsto (runbooks por fase).
