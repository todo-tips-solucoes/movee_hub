# Prompt C — Importações, interface e módulos funcionais (Sessões S3–S10)

> Modelo de prompt por fase; uma fase por sessão fresca, na ordem S3→S10.
> **Depende explicitamente da aprovação dos Prompts A e B (G2 aprovado + PR da S2
> mergeado com evidências). Não executar nenhuma fase antes disso.**

```text
Use /context-mode:context-mode durante toda a sessão. Rode
/feature-00c docs/plans/hub-frota/briefings/<briefing-da-fase>.md

PRÉ-CONDIÇÃO OBRIGATÓRIA: Prompts A e B aprovados (G2 + PR da S2 mergeado; fases
anteriores da ordem S3→S10 concluídas conforme DIARIO.md). Se não confirmar, PARE e
pergunte ao operador. Este prompt depende da aprovação das etapas anteriores.

FASES (um briefing autossuficiente por sessão, nesta ordem):
  S3  briefings/s3-shell-hub.md                — shell modular do hub
  S4  briefings/s4-pipeline-importacoes.md     — pipeline + telas de importação
  S5  briefings/s5-modulo-motoristas.md        — gestão de motoristas/entregadores
  S6  briefings/s6-modulo-faturamento.md       — módulo faturamento
  S7  briefings/s7-modulo-performance.md       — módulo performance
  S8  briefings/s8-envio-massa-modulo.md       — envio em massa como módulo (regressão!)
  S9  briefings/s9-auditoria-administracao.md  — auditoria + administração
  S10 briefings/s10-regressao-cutover.md       — regressão geral + ensaio de cutover

  ⚠️ S3–S9 rodam via /feature-00c; a S10 executa o briefing DIRETAMENTE (sem
  /feature-00c), conforme o prompt próprio do plano mestre §7. A ordem S3→S10 acima é a
  OFICIAL; a tabela de dependências do plano técnico (§16) é informativa e NÃO autoriza
  rodar fases em paralelo ou fora de ordem.

REGRAS COMUNS A TODAS AS FASES:
- Todo desenvolvimento SOMENTE no ambiente isolado validado na S1. O "homologação" antigo
  (VPSTodo, chatmasterveloz, *.moveelog.com.br) É PRODUÇÃO — nenhuma escrita lá, nunca.
  O cutover (G3) é executado PELO OPERADOR, fora destas sessões.
- Telas novas: design via /ui-ux-pro-max sobre o design system EntreGô 2.0 existente.
- Protocolo §5 do plano mestre: context-mode para pesquisa/análise; subagentes Explore
  para investigação ruidosa; CSVs reais só no sandbox (LGPD); artefatos em arquivos.
- Migrations: série única app_homologacao/backend/db/ (011+), expand-only, idempotentes,
  validadas em banco vazio + com dados antes de aplicar na homolog.
- Cada endpoint novo com requirePermission + escopo por entidade (token, nunca body).
- PROIBIDO: mudar endpoints legados fora do que o briefing da fase autorizar; dados
  pessoais em git/logs/contexto; tag latest; segredos no git; escrita em produção.
- TESTES por fase: unit + integração + E2E no ambiente isolado (exigência do briefing);
  evidências anexadas ao PR. Reimportação idempotente é critério permanente (reimportar
  o mesmo arquivo = 0 duplicatas).
- Contexto >70%: fechar a onda, salvar estado, retomar com /feature-00c-resume.
- INTERRUPÇÃO SEGURA: risco de alcançar produção → parar e devolver ao operador, sem
  procurar rota alternativa.

FECHAMENTO de cada fase: DIARIO.md + PR draft (branch feat/hub-<fase>) com evidências;
merge e gate são do operador. Critérios de aceite: briefing da fase + plano técnico §15/§17.
```
