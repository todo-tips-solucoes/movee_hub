-- 0110 — "EnvioMassa".conciliada_em / conciliada_origem: nota conferida FORA do sistema.
--
-- POR QUE EXISTE: o financeiro da Movee recebe as notas dos motoristas também
-- pela UneCont (relatório "Serviços Tomados", coluna Conferido? = Sim). Muitos
-- movimentos já fechados ficaram sem nota aprovada na EnvioMassa porque o
-- motorista mandou a nota por fora (ou o XML foi recusado e ele reemitiu). A
-- conciliação marca esses movimentos como aprovados; estas colunas guardam QUE
-- a aprovação veio da conciliação, e de qual nota — sem elas, `nota_ok` não
-- distingue nota validada pela FastAPI de nota conciliada por planilha.
--
-- SEMÂNTICA: NULL = não conciliada (todo o histórico). Preenchida = a nota
-- deste movimento foi conferida e paga fora do sistema; `conciliada_origem`
-- diz a fonte e a chave (ex.: 'UNECONT:<chave>'). Não muda nenhum
-- comportamento por si só: quem tira o movimento das pendências é `nota_ok`
-- preenchido + `erro_validacao` vazio (gravados pela própria conciliação).
--
-- PERMISSÃO: GRANT da EnvioMassa é por tabela (0033); as colunas herdam.
--
-- Aditiva e idempotente. Depois de aplicar: SIGUSR1 no PostgREST (cache de schema).

ALTER TABLE "EnvioMassa" ADD COLUMN IF NOT EXISTS conciliada_em timestamptz;
ALTER TABLE "EnvioMassa" ADD COLUMN IF NOT EXISTS conciliada_origem text;
