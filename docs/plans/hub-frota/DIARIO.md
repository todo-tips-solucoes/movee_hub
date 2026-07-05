# Diário do projeto Hub de Frota

Handoff entre sessões. Cada sessão apenda ~10 linhas no fechamento: o que fechou, decisões,
pendências, ponteiros (branch/PR/estado feature-00c).

---

## 2026-07-04 — Sessão de orquestração (plano mestre)

- **Fechou:** plano mestre de orquestração em `00-plano-mestre-orquestracao.md`; diretrizes
  (`docs/documentos_apoio/diretrizes_customizacao.txt`) versionadas no repo; reconhecimento
  dos ZIPs no sandbox context-mode (Faturamento: CSV `;` ~4.014 linhas/dia, 20 colunas;
  Performance: CSV `;` ~2.720 linhas/dia, 19 colunas; chave comum `id_da_pessoa_entregadora`).
- **Decisões:** roteiro S0–S10 com gates G1/G2/G3; skills obrigatórias context-mode +
  feature-00c + ui-ux-pro-max; recomendação de VPS separada para o ambiente isolado.
- **Pendências:** operador aprovar este plano (merge do PR) → rodar S0 com o prompt da §7;
  decisão de infra (G1) fica para depois da S0.
- **Ponteiros:** branch `worktree-plano-hub-frota`; ZIPs NÃO commitados (dados pessoais).

---

## 2026-07-05 — Sessão S0 (planejamento técnico profundo)

- **Fechou:** diretrizes executadas integralmente (etapas 1–23, 20 entregáveis):
  `01-plano-tecnico.md` + `prompts/prompt-{A,B,C}.md` + 9 briefings autossuficientes
  (`briefings/s2…s10`). Diagnósticos repo/Docker por subagentes Explore; análise dos 2
  CSVs 100% no sandbox context-mode (só estatísticas/exemplos mascarados no relatório).
- **Achados-chave:** CSVs sem chave natural única → dedupe por hash de arquivo+linha;
  decimal vírgula (fat.) vs ponto (perf.); 4,5% das linhas de faturamento sem UUID (bônus
  agregados); sem CNPJ nos CSVs → vínculo Entregador↔Motorista manual+sugestão (D3);
  backend↔PostgREST provavelmente via URL pública (confirmar na S1); VPSTodo sem folga
  (1,4 GiB RAM livre, disco 85%) → reforça VPS separada.
- **Decisões (a ratificar no G1):** VPS separada (D0); série única de migrations =
  `backend/db/011+`, `docs/sql/` congelada (D1); hub em Node 20 (D2); modelo Usuario/
  UsuarioEntidade/Papel/Permissao + RLS de reforço; fatos append-only.
- **Pendências:** operador revisar/mergear PR desta S0; decidir G1 (infra + subdomínio);
  D3–D7 (§18 do plano); recomendação: adicionar `docs/documentos_apoio/*.zip` ao
  .gitignore (fora do escopo de escrita da S0).
- **Ponteiros:** branch `docs/hub-frota-plano-tecnico` (PR draft); próximo passo após
  G1 = sessão fresca com `prompts/prompt-A.md` (S1).

---

## 2026-07-05 — Gate G1 (decisão do operador) + merge da S0

- **S0 mergeada:** PR #53 (merge `e5c0ee7c`) após code review de 8 ângulos — 19 achados
  corrigidos (`8bce8bf`), 3 refutados.
- **G1 DECIDIDO pelo operador (Paulo):**
  - **D0 = MESMO HOST (VPSTodo)** — Alternativa B do plano (§4.2). Recursos verificados
    após upgrade: 8 vCPU, 15 Gi RAM (8,7 Gi disponíveis), swap 8 Gi; disco 85% (23 GB
    livres) → operador executa `docker builder prune -a -f` antes da S1 (~43 GB recuperáveis).
  - **Subdomínio de homolog:** `hub-homolog.todo-tips.com`. Roteamento TLS é decisão de
    design da S1 (2ª instância Traefik em portas altas vs. rota no Traefik existente —
    esta última mexe em produção e exige o operador).
  - **D1 e D2 ratificadas** (série única `backend/db/011+`, docs/sql congelada; hub em Node 20).
  - **D4 CONFIRMADA** (`soma_das_taxas` em centavos; `tempo_disponivel_escalado` em %) —
    S4/S7 liberadas dessa pendência.
  - **Exceção standing auditada à cláusula pétrea (escopada, S1–S10):** o agente pode
    criar/gerir no VPSTodo SOMENTE recursos prefixados `hub-`/`hub_` (projetos compose
    hub-dev/test/homolog, redes/volumes/containers `hub_*`, banco novo do hub). Tudo do
    ambiente vivo (Swarm, stacks `envio-massa-homologacao_*`/`fastapi*`/`pgadmin`,
    banco `chatmasterveloz`, `.env`, Traefik de produção) permanece intocável; na dúvida,
    parar e devolver ao operador.
- **Pendências:** operador rodar o prune e colar a saída; depois sessão fresca com
  `prompts/prompt-A.md` (já preenchido com as decisões do G1).
