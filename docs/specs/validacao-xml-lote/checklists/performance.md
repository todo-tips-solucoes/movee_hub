# Performance Checklist: Validação de XML em Lote Idempotente

**Purpose**: Quality gate de requisitos de performance — targets de latência/throughput para lotes, comportamento de degradação, rate-limit e impacto no frontend.
**Created**: 2026-06-14
**Feature**: [spec.md](../spec.md) · [research.md](../research.md)

---

## Targets Mensuráveis

- [ ] CHK201 — Há target de latência máxima definido para o processamento de um lote de N XMLs (ex: lote de 10 XMLs todo `ja_validada` deve completar em < X segundos)? [Gap] {humano}
  > A spec não define SLA de latência para o endpoint. O rate-limit de 2s por linha implica latência mínima de 2×(N chamadas FastAPI)s para lotes que precisam de validação, mas não há target definido nem separação por caso (lote idempotente vs. lote com novas validações). Decisão de produto.

- [x] CHK202 — Está especificado que lotes de reenvio (maioria `ja_validada`) têm latência significativamente menor por não acionar o delay de rate-limit? [Completude, Research §Decision 5] {auto}
  > Evidência: Research §Decision 5: "o delay de 2s entre arquivos passa a ocorrer apenas quando houve chamada real à FastAPI (status `validada`/`revalidada`). Linhas `ja_validada`/`duplicada_no_lote`/`sem_movimento`/`erro-de-parsing` não esperam." O requisito de otimização do caso idempotente está explicitamente documentado.

- [ ] CHK203 — Há target de throughput máximo definido para chamadas simultâneas ao endpoint (N usuários fazendo upload ao mesmo tempo)? [Gap] {humano}
  > Sem especificação de throughput máximo ou comportamento sob carga concorrente. Dados relevantes: o rate-limit de 2s/linha é por-request (não compartilhado), mas múltiplas requests simultâneas podem saturar a FastAPI ou o banco PostgREST simultaneamente. Decisão de produto/ops.

---

## Degradação Graciosa

- [x] CHK204 — Está especificado que falha no serviço externo (FastAPI indisponível) para um XML não interrompe o processamento dos demais XMLs do lote? [Completude, Spec §FR-015, Quickstart §Cenário 7] {auto}
  > Evidência: FR-015: "Falha em uma linha do lote (parsing, serviço, casamento) não interrompe o processamento das demais linhas." Quickstart Cenário 7 cobre "FastAPI infra down → `erro` (resiliência, FR-014/FR-015)". SC-005: "100% das linhas restantes são processadas e retornam status."

- [x] CHK205 — Está especificado que XMLs com casamento por fallback (CNPJ+número+data) têm o mesmo tratamento de resiliência que os com casamento primário? [Completude, Spec §FR-003/FR-015] {auto}
  > Evidência: FR-003 define o fallback; FR-015 se aplica a todas as linhas sem distinção por estratégia de casamento. O fallback é transparente para a resiliência do lote — falha de fallback resulta em `sem_movimento`, não em aborto do lote.

- [ ] CHK206 — Está especificado o comportamento quando o PostgREST (banco de movimentos) está temporariamente indisponível durante o processamento de um lote em andamento? [Gap] {humano}
  > FR-014/FR-015 cobrem falha da FastAPI, mas não especificam o comportamento quando a consulta ao PostgREST para carregar movimentos falha (ex: timeout de banco). Seria `erro` por linha? Aborto do lote com 503? Decisão de arquitetura/produto.

---

## Carga e Escalonamento

- [x] CHK207 — Está especificado que o índice de casamento de movimentos é carregado uma única vez por lote (não por XML), evitando N queries ao banco? [Completude, Plan §Convenções de Borda, Research §Decision 2] {auto}
  > Evidência: Plan §Convenções de Borda: "load-once: a query de movimentos abertos (`id_empresa=eq.X&mov_fechado=eq.false`) roda uma única vez por lote — não por XML." Research §Decision 2 confirma a estratégia de "carregar todos os movimentos abertos da empresa, construir índices in-memory, processar XMLs sem queries adicionais."

- [x] CHK208 — Está especificado que o dedup de XMLs duplicados no lote opera in-memory (sem consulta ao banco para cada ocorrência)? [Completude, Spec §FR-009, Research §Decision 3] {auto}
  > Evidência: FR-009: "valida uma única vez; as demais ocorrências recebem `duplicada_no_lote` sem nova chamada ao serviço externo." Research §Decision 3 e Data Model §XmlExtractedFields confirmam que o dedup é por chave de acesso mantida in-memory durante o processamento do lote.

- [ ] CHK209 — Há especificação do impacto de memória para lotes grandes (ex: 100 XMLs × N movimentos abertos na empresa)? [Gap] {humano}
  > A estratégia "load-once" é eficiente em queries, mas carrega todos os movimentos abertos da empresa em memória para construir os índices. Sem especificação de limite de movimentos por empresa que o sistema suporta, há risco de OOM para empresas com muitos movimentos abertos. Decisão técnica.

---

## Frontend / UX de Performance

- [x] CHK210 — Está especificado que o feedback visual de resultado (tabela de status por linha) é exibido após o retorno do endpoint, sem polling adicional? [Completude, Spec §FR-017/FR-018/FR-019, Clarify §Q4] {auto}
  > Evidência: Clarify §Q4: "a tabela de resultados com os novos status substitui completamente o feedback atual de validação de XML no painel." FR-017/FR-018 definem a tabela de resultado por linha. O fluxo é síncrono (upload → resposta → exibição), sem polling, por design do handler existente.

- [ ] CHK211 — Está especificado o comportamento de UX durante o processamento de lotes longos (indicador de progresso, timeout de browser, feedback parcial)? [Gap] {humano}
  > Para lotes com muitas novas validações (ex: 50 XMLs × 2s de rate-limit = ~100s de espera), o usuário fica aguardando resposta HTTP. A spec não especifica se há indicador de progresso, feedback parcial, ou estratégia para evitar timeout de browser em lotes longos. Decisão de produto/UX.

---

## Observabilidade de Performance

- [ ] CHK212 — Estão especificados os métricas de performance a serem monitoradas em produção (ex: latência média por lote, taxa de `ja_validada` vs. chamadas reais à FastAPI)? [Gap] {humano}
  > O campo `stats` na response oferece distribuição de status por lote, mas não há requisito de logging ou métricas de performance para monitoramento em produção (ex: percentual de lotes que acionam o rate-limit, tempo médio de resposta). Decisão de produto/ops.

---

## Notes

- Items `{auto}` resolvidos com citação de evidência nos artefatos (`[x]`).
- Items `{humano}` aguardam decisão do dono do produto (`[ ]`).
- `[Gap]` indica requisito ausente que deve virar tarefa em `/create-tasks`.
- CHK201, CHK203, CHK206, CHK209, CHK211, CHK212 são gaps de performance identificados.
- A maioria dos gaps de performance são "nice-to-have" (latência, throughput) — o único de risco real é CHK209 (OOM em empresas grandes) e CHK211 (UX em lotes longos).
