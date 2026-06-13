# API Checklist: Gorjeta do Motorista

**Purpose**: Validar qualidade dos requisitos de contrato de API — endpoint, shape de resposta, error handling e isolamento multi-tenant.
**Created**: 2026-06-12
**Feature**: [spec.md](../spec.md) | [plan.md](../plan.md)

## Completude de Requisitos — Contrato de Endpoint

- [x] CHK101 - O campo `gorjeta` está especificado no contrato de resposta do endpoint `/movimento-aberto`? [Completude, Spec §FR-004, Plan §4.3] {auto}
  > Evidência: FR-004 "endpoint DEVE retornar o campo `gorjeta` no payload"; Plan §4.3 descreve adição de `gorjeta: row.gorjeta` no mapper do `/movimento-aberto` em `motorista.js:~395`.

- [x] CHK102 - O tipo do campo `gorjeta` na resposta da API está especificado (string numérica ou null, não number)? [Completude, Spec §FR-004, Plan §4.3, CL-001] {auto}
  > Evidência: CL-001 define gravação como `valorNum.toFixed(2)` (string TEXT); Plan §4.3 diz `gorjeta: row.gorjeta` — repassa o valor do banco diretamente. Tipo é `string | null`.

- [x] CHK103 - O shape de resposta do `/movimento-aberto` está documentado para ambos os estados (com e sem gorjeta)? [Completude, Plan §6.2] {auto}
  > Evidência: Plan §6.2 "Backend — leitura" define cenários: gorjeta `"22.00"` e gorjeta `null`. Shape inferível; formato explícito via `motorista-integration.test.js`.

- [ ] CHK104 - Existe especificação do shape completo (JSON schema ou exemplo) do payload do `/movimento-aberto` com o novo campo? [Completude, Gap, Plan §4.3] {auto}
  > [Gap]: Plan §4.3 descreve apenas o delta (adicionar `gorjeta` ao mapper) e Plan §6.2 descreve cenários de teste, mas não há exemplo JSON completo do payload de resposta documentado. Não bloqueia a implementação, mas dificulta validação de contrato por consumidores futuros.

## Clareza de Requisitos — API

- [x] CHK105 - FR-004 ("retornar o campo gorjeta") é claro sobre quando retornar null vs. omitir o campo? [Clareza, Spec §FR-004, CL-003] {auto}
  > Evidência: FR-004 define "com o valor numérico ou `null`" — campo sempre presente na resposta, nunca omitido. CL-003 só se aplica ao render da tela, não ao contrato da API.

- [x] CHK106 - O requisito FR-004 é claro sobre qual endpoint retorna gorjeta (o de upload ou o de consulta)? [Clareza, Spec §FR-004, Plan §4.3] {auto}
  > Evidência: FR-004 especifica "endpoint de consulta do movimento aberto" (rota `/movimento-aberto`). Não confunde com o endpoint de upload (distinto). Claro.

## Consistência de Requisitos — API

- [x] CHK107 - Os requisitos de API são consistentes com o isolamento multi-tenant da constitution? [Consistência, Constitution §II, Spec §FR-004] {auto}
  > Evidência: Constitution §II.MUST "toda operação escopada por identificador extraído do token". O endpoint `/movimento-aberto` já usa `authenticateMotorist` + filtro por `cnpj_prestador` do token — a gorjeta é uma coluna aditiva na mesma tabela já filtrada.

- [x] CHK108 - O endpoint de upload (que recebe gorjeta) é o mesmo endpoint já existente, sem criação de rota nova? [Consistência, Plan §4.2, Spec §7 Escopo] {auto}
  > Evidência: Plan §4.2 descreve adição em `server.js` no objeto `dataToInsert` existente (linha ~1455); Spec §7 confirma que o endpoint de upload não muda de rota, apenas incorpora novo campo.

## Qualidade dos Critérios de Aceitação — API

- [x] CHK109 - SC-003 ("motorista vê a gorjeta em até 1 recarregamento") implica latência de propagação entre upload e consulta — isso está documentado como premissa? [Mensurabilidade, Spec §SC-003, Plan §5] {auto}
  > Evidência: SC-003 define "até 1 recarregamento após o upload ser processado". Implica fluxo síncrono: upload → banco → query. Plan §5 garante que após deploy o PostgREST já expõe a coluna — propagação é imediata, não eventual.

## Error Handling

- [x] CHK110 - Existe requisito cobrindo o comportamento da API se o PostgREST receber insert com coluna `gorjeta` inexistente no schema (banco desatualizado)? [Cobertura, Spec §Edge Cases, Plan §5] {auto}
  > Evidência: Spec §Edge Cases define "sistema deve falhar apenas no campo gorjeta, nunca corromper os demais campos". Plan §5 mitiga pela ordem de deploy; o edge case de banco desatualizado está documentado como situação prevenível, não tratável em runtime.

- [ ] CHK111 - Existe requisito definindo o código HTTP de retorno do upload quando o banco está desatualizado (coluna gorjeta ausente)? [Cobertura, Gap] {auto}
  > [Gap]: Spec §Edge Cases define que o sistema "deve falhar apenas no campo gorjeta", mas não especifica o código HTTP retornado (4xx? 500? qual mensagem?). O comportamento atual do PostgREST seria rejeitar o POST inteiro com 400/409 — não apenas a gorjeta. Há contradição entre a spec ("falhar apenas no campo") e o comportamento real do PostgREST (rejeita a linha toda). Isso deve ser resolvido em `/clarify`.

- [x] CHK112 - O requisito de "zero erro 500 por gorjeta" está coberto para todos os caminhos de input inválido? [Cobertura, Spec §Edge Cases, Plan §6.1] {auto}
  > Evidência: Plan §6.1 tabela de cenários inclui "Texto não-monetário → gorjeta: null; sem 500". Spec §Edge Cases confirma. Cobertura presente.

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`/`[Conflict]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- **CHK104** `[Gap]`: falta JSON schema / exemplo completo do payload — baixo impacto para implementação imediata, mas relevante para contratos futuros.
- **CHK111** `[Conflict]`: há contradição entre spec ("falhar apenas no campo gorjeta") e comportamento real do PostgREST (rejeita a linha inteira). Recomendar `/clarify` para resolver.
