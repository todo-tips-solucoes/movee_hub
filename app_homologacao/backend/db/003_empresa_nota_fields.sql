-- 003_empresa_nota_fields.sql
-- Adiciona dados de contato/fiscais do TOMADOR (Empresa) para auxiliar o
-- motorista na emissão da NFS-e (exibidos na tela do valor do movimento).
-- `email_nota` é separado do `email` de login (não sobrescreve o acesso).
-- Rodar no banco de produção (psql/pgadmin) e recarregar o schema do PostgREST.

ALTER TABLE "Empresa" ADD COLUMN IF NOT EXISTS endereco   text;
ALTER TABLE "Empresa" ADD COLUMN IF NOT EXISTS numero     text;
ALTER TABLE "Empresa" ADD COLUMN IF NOT EXISTS cep        text;
ALTER TABLE "Empresa" ADD COLUMN IF NOT EXISTS email_nota text;
ALTER TABLE "Empresa" ADD COLUMN IF NOT EXISTS observacao text;

-- Movee (id = 6)
UPDATE "Empresa" SET
  endereco   = 'Av Alfredo Egidio de Souza Aranha',
  numero     = '333',
  cep        = '04726-170',
  email_nota = 'financeiro@moveelog.com.br',
  observacao = E'Fique atento ao código de serviço, de acordo com o sistema de emissão da NF.\n\nSe for emitida no site da Prefeitura do Município: CNAE 53.20.20-2 - Código de Serviço 02461.\n\nSe for emitida no Sistema da Nota Fiscal Nacional: CNAE 53.20.20-2 - Código de Serviço 26.01.01 - NBS 1.0703.00.00.\n\nImportante ressaltar que MEI não tem retenção de ISS. Caso isso ocorra, será necessário cancelar a NF e emitir sem a retenção desse imposto.'
WHERE id = 6;

-- Expor as novas colunas no PostgREST (cache de schema)
NOTIFY pgrst, 'reload schema';
