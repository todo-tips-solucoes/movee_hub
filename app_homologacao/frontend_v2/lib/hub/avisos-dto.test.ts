// hub-avisos (push-motorista, FASE 7 — tasks.md 7.4.3): invariante SC-006
// (aceitos+falhas+mortas = visados quando concluido), verificada no parser
// de avisos-dto.ts (`parseAvisoDetalhe`/`contagensBatem`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contagensBatem, parseAvisoDetalhe } from './avisos-dto';

function detalheRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    titulo: 'Aviso',
    corpo: 'Corpo',
    status: 'concluido',
    modoDestinatarios: 'toda_base',
    destinatarios: {},
    criadoEm: '2026-09-01T10:00:00Z',
    iniciadoEm: '2026-09-01T10:00:05Z',
    concluidoEm: '2026-09-01T10:01:00Z',
    contagens: { visados: 10, pendentes: 0, processando: 0, aceitos: 7, falhas: 2, mortas: 1 },
    ...overrides,
  };
}

describe('contagensBatem (SC-006)', () => {
  it('bate quando concluido e a soma confere', () => {
    expect(
      contagensBatem({ status: 'concluido', contagens: { visados: 10, aceitos: 7, falhas: 2, mortas: 1 } })
    ).toBe(true);
  });

  it('não bate quando concluido e a soma diverge', () => {
    expect(
      contagensBatem({ status: 'concluido', contagens: { visados: 10, aceitos: 7, falhas: 2, mortas: 0 } })
    ).toBe(false);
  });

  it('não se aplica fora de concluido (sempre true, mesmo com soma divergente)', () => {
    expect(
      contagensBatem({ status: 'em_andamento', contagens: { visados: 10, aceitos: 1, falhas: 0, mortas: 0 } })
    ).toBe(true);
  });
});

describe('parseAvisoDetalhe — sinalização da invariante (dev only)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('não avisa quando a soma confere', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseAvisoDetalhe(detalheRaw());
    expect(warn).not.toHaveBeenCalled();
  });

  it('avisa via console.warn quando concluido e a soma diverge (não lança)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = detalheRaw({ contagens: { visados: 10, pendentes: 0, processando: 0, aceitos: 7, falhas: 2, mortas: 0 } });
    expect(() => parseAvisoDetalhe(raw)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('AvisoDetalhe #1');
  });
});
