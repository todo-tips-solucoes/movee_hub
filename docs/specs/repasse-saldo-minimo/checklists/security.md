# Security Checklist: repasse-saldo-minimo (F2 — aprovação restrita e trava de papel)

**Purpose**: validar a qualidade dos requisitos de autorização da F2 (papel `financeiro_aprovador`, trava de papel restrito na rota e no banco, REVOKE na matriz) e da escrita restrita do piso (F3).
**Created**: 2026-09-26
**Feature**: [spec.md](../spec.md)

## Completude

- [x] CHK001 - As três ações restritas (fechar apuração, gerar notas, confirmar/devolver lote) estão enumeradas, com os papéis que as executam? [Completude, Spec §FR-006] {auto}
- [x] CHK002 - Está definido o que o papel novo concede em relação ao `financeiro` (superconjunto + aprovar)? [Completude, Spec §FR-008; data-model invariante `aprovador − financeiro = {pagamento_confirmar}`] {auto}
- [x] CHK003 - Todos os pontos de escrita de vínculo estão cobertos pela trava (criar usuário, criar vínculo, alterar/desativar vínculo)? [Completude, contracts/hub-usuarios-trava.md "Pontos de escrita cobertos" — `:214`, `:397`, `:478`] {auto}
- [x] CHK004 - A edição do usuário-alvo (senha, nome, ativo) está coberta como vetor de tomada de conta? [Completude, Spec §FR-012a; research Decision 6; contrato `PUT /usuarios/:id` `:325`] {auto}
- [x] CHK005 - A escrita direta na matriz `Papel/PapelPermissao/Permissao/Modulo` está vedada por requisito, não só por implementação? [Completude, Spec §FR-012b; research Decision 5] {auto}
- [x] CHK006 - O requisito de negar pela camada de dados (sem passar pela tela) está declarado e tem cenário? [Completude, Spec §FR-010; quickstart F2.4 passo 2; contrato "Camada de banco"] {auto}
- [x] CHK007 - A escrita do piso mínimo está restrita a `pagamento_confirmar` no backend E no banco? [Completude, Spec §FR-026; research Decision 12 `PERMISSAO_NEGADA_PISO`] {auto}
- [x] CHK008 - O rollback da F2 especifica o que devolve (políticas, papel, GRANT da matriz) e quando recusa? [Completude, plan F2 passo 3; quickstart F2.6] {auto}

## Clareza

- [x] CHK009 - "Motivo identificável" da negativa está concretizado num código de erro único? [Clareza, Spec §FR-010; contrato `403 PAPEL_RESTRITO` (PROPOSTA)] {auto}
- [x] CHK010 - "Papel restrito" está definido por lista fechada? [Clareza, contrato: `admin_plataforma`, `financeiro_aprovador`] {auto}
- [x] CHK011 - O critério de "alvo protegido" em `PUT /usuarios/:id` é inequívoco (vínculo ATIVO com papel restrito, em qualquer entidade)? [Clareza, research Decision 6] {auto}
- [x] CHK012 - O resultado esperado do UPDATE bloqueado por `USING` (0 linhas, sem erro) está explicitado para não virar falso "sucesso"? [Clareza, research Decision 4; plan S4] {auto}

## Consistência

- [x] CHK013 - Spec, plan, research e contrato dizem o mesmo sobre S1/S2 após o block-005 (sem marcador pendente)? [Consistência, Spec §FR-012a/FR-012b; plan "Decisões do operador"] {auto}
- [x] CHK014 - A regra vale igual quando o alvo é o próprio chamador? [Consistência, Spec §Edge Cases; contrato "A checagem vale mesmo quando o alvo é o próprio chamador"] {auto}
- [x] CHK015 - A ausência de aprovador (papel recém-criado, sem ninguém) tem comportamento definido? [Consistência, Spec §Edge Cases — só admin plataforma] {auto}

## Critérios de aceite e cenários

- [x] CHK016 - SC-003 e SC-004 ("100% recusadas") são mensuráveis por um conjunto enumerado de tentativas? [Mensurabilidade, quickstart F2.1 e F2.4] {auto}
- [x] CHK017 - Existe controle negativo que prove o furo ANTES da correção, cobrindo rota, PostgREST, `PUT /usuarios/:id` e matriz? [Cobertura, quickstart F2.0 — 4 chamadas passam em 0096] {auto}
- [x] CHK018 - Não-regressão para papéis comuns tem cenário próprio? [Cobertura, Spec §FR-011; quickstart F2.5] {auto}

## Não-funcionais / auditoria

- [x] CHK019 - Toda negativa é auditada sem dado pessoal e sem tela nova? [Spec §FR-012; data-model "Auditoria" — ids de usuário/papel, rota] {auto}
- [x] CHK020 - A falha ao gravar auditoria é fail-closed (a negativa não vira permissão)? [NFR, plan S3] {auto}

## Dependências e premissas (dono do produto / operador)

- [ ] CHK021 - Confirmado em produção que `JWT_SECRET` ≠ `PGRST_JWT_SECRET` (premissa da defesa S2)? [Assumption, plan "Ordem de deploy" F2; quickstart F2.6 passo 4] {humano}
- [ ] CHK022 - Confirmado que o único `admin_plataforma` atual é quem deveria ser, e definido quem recebe `financeiro_aprovador` no go-live? [Assumption, plan F2 pré-requisitos] {humano}
- [ ] CHK023 - As 2 pessoas que perdem a aprovação (financeiro, admin_entidade) foram avisadas antes do deploy? [Dependência, plan Riscos] {humano}

## Notes

- Items `{auto}` resolvidos pelo agente com citação; `{humano}` aguardam o operador antes do deploy da F2 (não bloqueiam `create-tasks`/`execute-task` no ambiente isolado).
- CHK004/CHK005 foram fechados nesta rodada com FR-012a/FR-012b acrescentados à spec (block-005).
