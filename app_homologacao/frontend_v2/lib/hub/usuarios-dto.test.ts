import { describe, expect, it } from 'vitest';
import { parseUsuarioListItem } from './usuarios-dto';

// A tela mocka a API, então só aqui se prova que o campo atravessa o parse.
describe('parseUsuarioListItem — nuncaAcessou', () => {
  const base = { id: 1, nome: 'Ana', email: 'a@x.com', ativo: true, vinculos: [] };
  it('repassa true/false e trata ausência como false', () => {
    expect(parseUsuarioListItem({ ...base, nuncaAcessou: true }).nuncaAcessou).toBe(true);
    expect(parseUsuarioListItem({ ...base, nuncaAcessou: false }).nuncaAcessou).toBe(false);
    expect(parseUsuarioListItem(base).nuncaAcessou).toBe(false);
  });
});
