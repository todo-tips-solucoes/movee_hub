// "Esqueci minha senha" — cliente das rotas de recuperação (2026-09-25).
import { api } from './api-client.ts';

export interface RecuperarSenhaResposta {
  ok: true;
  /** E-mail mascarado para onde a recuperação foi enviada, ou `null` quando
   *  não houve envio. A resposta é a MESMA quando a conta não existe ou não
   *  tem e-mail — a rota não revela qual foi o caso. */
  emailMascarado: string | null;
}

export function pedirRecuperacaoSenha(cnpjPrestador: string): Promise<RecuperarSenhaResposta> {
  return api.post<RecuperarSenhaResposta>('/motorista/recuperar-senha', { cnpjPrestador });
}

export function definirSenhaComToken(token: string, novaSenha: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>('/motorista/definir-senha', { token, novaSenha });
}
