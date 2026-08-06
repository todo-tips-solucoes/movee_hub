// Casos que quebram se a matemática de período errar: virada de mês, virada
// de ano, e o fuso (UTC-3 tarde da noite, onde `toISOString()` adiantaria o dia).
import { describe, expect, it } from 'vitest';
import {
  formatarISOparaBR,
  intervaloDoPreset,
  paraISO,
  presetAtivo,
} from './periodo';

// 15/03/2026, 22h local — se alguém trocar a implementação por `toISOString()`,
// em UTC-3 este horário vira 16/03 e todos os testes abaixo caem.
const QUINZE_MARCO = new Date(2026, 2, 15, 22, 0, 0);

describe('paraISO', () => {
  it('usa o dia LOCAL, não o UTC (22h em UTC-3 continua sendo dia 15)', () => {
    expect(paraISO(QUINZE_MARCO)).toBe('2026-03-15');
  });

  it('preenche mês e dia com zero à esquerda', () => {
    expect(paraISO(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('intervaloDoPreset', () => {
  it('hoje: de e ate no mesmo dia', () => {
    expect(intervaloDoPreset('hoje', QUINZE_MARCO)).toEqual({ de: '2026-03-15', ate: '2026-03-15' });
  });

  it('7 dias INCLUI hoje (09..15, não 08..15)', () => {
    expect(intervaloDoPreset('7d', QUINZE_MARCO)).toEqual({ de: '2026-03-09', ate: '2026-03-15' });
  });

  it('30 dias atravessa a virada de mês', () => {
    expect(intervaloDoPreset('30d', QUINZE_MARCO)).toEqual({ de: '2026-02-14', ate: '2026-03-15' });
  });

  it('este mês começa no dia 1º', () => {
    expect(intervaloDoPreset('mes', QUINZE_MARCO)).toEqual({ de: '2026-03-01', ate: '2026-03-15' });
  });

  it('30 dias atravessa a virada de ANO', () => {
    expect(intervaloDoPreset('30d', new Date(2026, 0, 10))).toEqual({
      de: '2025-12-12',
      ate: '2026-01-10',
    });
  });

  it('este mês no dia 1º devolve um intervalo de um dia só', () => {
    expect(intervaloDoPreset('mes', new Date(2026, 2, 1))).toEqual({
      de: '2026-03-01',
      ate: '2026-03-01',
    });
  });
});

describe('presetAtivo', () => {
  it('reconhece o intervalo gerado pelo próprio preset (ida e volta)', () => {
    const i = intervaloDoPreset('7d', QUINZE_MARCO);
    expect(presetAtivo(i.de, i.ate, QUINZE_MARCO)).toBe('7d');
  });

  it('intervalo digitado à mão não acende nenhum chip', () => {
    expect(presetAtivo('2026-03-02', '2026-03-11', QUINZE_MARCO)).toBeNull();
  });

  it('intervalo pela metade não acende nenhum chip', () => {
    expect(presetAtivo('2026-03-15', '', QUINZE_MARCO)).toBeNull();
    expect(presetAtivo('', '', QUINZE_MARCO)).toBeNull();
  });
});

describe('formatarISOparaBR', () => {
  it('converte para o formato que o operador brasileiro lê', () => {
    expect(formatarISOparaBR('2026-03-09')).toBe('09/03/2026');
  });

  it('devolve null para vazio ou lixo — sem inventar data', () => {
    expect(formatarISOparaBR('')).toBeNull();
    expect(formatarISOparaBR('09/03/2026')).toBeNull();
  });
});
