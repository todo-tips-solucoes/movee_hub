// Garante que o detalhe que o backend manda sobrevive até a tela. Antes, o
// `handleResponse` fazia `new Error(body.message)` e as linhas recusadas — que o
// servidor já tinha calculado — morriam ali.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { api, ApiError, lerErroApi } from './api-client';

function respostaDeErro(body: unknown, status = 400) {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('ApiError — linhas inválidas do upload', () => {
  it('preserva rowIndex e motivos que o backend mandou', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respostaDeErro({
      success: false,
      message: 'Erros de validação encontrados. Nenhum registro foi inserido.',
      errors: [
        { rowIndex: 329, errors: ['cnpj_prestador inválido (deve conter 14 dígitos).'], preview: { nome: 'Fulano', number: '(11)99999-9999' } },
        { rowIndex: 542, errors: ['cnpj_prestador inválido (deve conter 14 dígitos).', 'nome é obrigatório.'], preview: {} },
      ],
    })));

    const erro = (await api.uploadFile('/upload', new File(['x'], 'p.xlsx')).catch((e) => e)) as ApiError;
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.status).toBe(400);
    expect(erro.message).toMatch(/Nenhum registro foi inserido/);
    expect(erro.linhasInvalidas).toEqual([
      { linha: 329, motivos: ['cnpj_prestador inválido (deve conter 14 dígitos).'] },
      { linha: 542, motivos: ['cnpj_prestador inválido (deve conter 14 dígitos).', 'nome é obrigatório.'] },
    ]);
  });

  it('não carrega o preview adiante — a linha tem nome e telefone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respostaDeErro({
      message: 'x',
      errors: [{ rowIndex: 7, errors: ['nome é obrigatório.'], preview: { nome: 'Sicrano', number: '5511988887777' } }],
    })));
    const erro = (await api.uploadFile('/upload', new File(['x'], 'p.xlsx')).catch((e) => e)) as ApiError;
    expect(JSON.stringify(erro.linhasInvalidas)).not.toMatch(/Sicrano|5511988887777/);
  });

  it('erro sem `errors` continua sendo erro, com lista vazia', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respostaDeErro({ message: 'dt_inicial é obrigatório para o import.' })));
    const erro = (await api.uploadFile('/upload', new File(['x'], 'p.xlsx')).catch((e) => e)) as ApiError;
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.linhasInvalidas).toEqual([]);
    expect(erro.message).toMatch(/dt_inicial/);
  });

  it('item malformado é descartado sem derrubar os bons', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respostaDeErro({
      message: 'x',
      errors: [
        { rowIndex: 'nao-numero', errors: ['a'] },
        { rowIndex: 10 },                        // sem motivos
        { rowIndex: 11, errors: ['motivo bom'] },
        null,
      ],
    })));
    const erro = (await api.uploadFile('/upload', new File(['x'], 'p.xlsx')).catch((e) => e)) as ApiError;
    expect(erro.linhasInvalidas).toEqual([{ linha: 11, motivos: ['motivo bom'] }]);
  });

  it('401 continua sendo "Não autorizado", sem virar ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respostaDeErro({}, 401)));
    const erro = (await api.uploadFile('/upload', new File(['x'], 'p.xlsx')).catch((e) => e)) as ApiError;
    expect(erro).not.toBeInstanceOf(ApiError);
    expect(erro.message).toBe('Não autorizado');
  });
});

describe('lerErroApi — todo formato de erro do backend vira texto legível', () => {
  it('{error:{code}} (403 do Fechar movimento) nunca vira "[object Object]"', () => {
    const r = lerErroApi({ error: { code: 'PERMISSAO_INSUFICIENTE' } }, 403);
    expect(r.codigo).toBe('PERMISSAO_INSUFICIENTE');
    expect(r.mensagem).toBe('Seu perfil não tem permissão para esta ação.');
  });
  it('{error:{code,message}} prefere a mensagem do servidor', () => {
    expect(lerErroApi({ error: { code: 'SEM_ENTIDADE_ATIVA', message: 'Selecione X' } }, 403)).toEqual({
      mensagem: 'Selecione X',
      codigo: 'SEM_ENTIDADE_ATIVA',
    });
  });
  it('{error:"texto"} legado e {message} passam como vieram', () => {
    expect(lerErroApi({ error: 'CNPJ já cadastrado' }, 409).mensagem).toBe('CNPJ já cadastrado');
    expect(lerErroApi({ message: 'Erros de validação', error: 'x' }, 400).mensagem).toBe('Erros de validação');
  });
  it('{erro:"CODIGO"} do hub usa o mapa de códigos', () => {
    expect(lerErroApi({ erro: 'PERMISSAO_NEGADA' }, 403)).toEqual({
      mensagem: 'Seu perfil não tem permissão para esta ação.',
      codigo: 'PERMISSAO_NEGADA',
    });
  });
  it('código desconhecido, corpo vazio ou não-objeto caem na mensagem com o status', () => {
    expect(lerErroApi({ erro: 'XPTO' }, 500).mensagem).toBe('Erro 500. Tente novamente.');
    expect(lerErroApi(null, 502).mensagem).toBe('Erro 502. Tente novamente.');
    expect(lerErroApi('texto', 400).mensagem).toBe('Erro 400. Tente novamente.');
  });
  it('ApiError carrega o codigo vindo do corpo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respostaDeErro({ error: { code: 'PERMISSAO_INSUFICIENTE' } }, 403)));
    const erro = (await api.post('/close-movimento').catch((e) => e)) as ApiError;
    expect(erro.codigo).toBe('PERMISSAO_INSUFICIENTE');
    expect(erro.message).not.toContain('object');
  });
});
