export interface EnvioMassa {
  id: number;
  number: string;
  nome: string;
  valor: number | string;
  cnpj_tomador: string;
  cnpj_prestador: string;
  mensagem1: string;
  mensagem2: string;
  enviado: 'off' | 'ok' | 'erro' | string;
  retorno_envio_msg_1: string | null;
  retorno_envio_msg_2: string | null;
  tribnac: string | null;
  dCompet: string | null;
  numnota: string | null;
  nota_ok: string | null;
  data_emissao: string | null;
  erro_validacao: string | null;
  uuid: string | null;
  dt_inicial: string | null;
  dt_final: string | null;
  id_empresa: number;
  created_at: string;
  mov_fechado: boolean;
}

export interface AuthUser {
  authenticated: boolean;
  nome_empresa: string;
  // config-ui-tenant: claims de grupo expostos pelo /verify-auth
  is_grupo_pai?: boolean;
  id_grupo?: number | null;
}

export interface ProcessStatus {
  active: boolean;
  execution_id?: string;
}

export interface FilterState {
  numero: string;
  nome: string;
  valor: string;
  numNota: string;
  dataEmissao: string;
  enviado: string;
  sucesso: string;
  validacao: string;
  enviouNota: string;
}

export interface StatsData {
  total: number;
  msgEnviada: number;
  msgErro: number;
  xmlEnviado: number;
  xmlErro: number;
}
