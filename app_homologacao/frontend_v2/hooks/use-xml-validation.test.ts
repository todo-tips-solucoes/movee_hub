import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useXmlValidation } from './use-xml-validation';

afterEach(() => vi.unstubAllGlobals());

async function validarComResposta(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => body } as Response));
  const { result } = renderHook(() => useXmlValidation());
  await act(async () => {
    await result.current.validateBatch([new File(['x'], 'a.xml')], false).catch(() => {});
  });
  return result.current.error;
}

describe('useXmlValidation — erros', () => {
  it('403 de permissão diz permissão, não "indisponível"', async () => {
    const msg = await validarComResposta(403, { error: { code: 'PERMISSAO_INSUFICIENTE' } });
    expect(msg).toBe('Seu perfil não tem permissão para esta ação.');
  });
  it('5xx segue sendo "indisponível" e 4xx com detail propaga o detail', async () => {
    expect(await validarComResposta(502, { detail: 'x' })).toMatch(/indisponivel/);
    expect(await validarComResposta(422, { detail: 'Nenhum motorista ativo' })).toBe('Nenhum motorista ativo');
  });
});
