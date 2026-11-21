/** Test mode: conditions and values worked out by Grid's formulas, and every way through a dialogue checked. */

import { describe, it, expect } from 'vitest';
import { GraphModel } from '../src/js/model.js';
import { calculate, assignments, applySet, startNode, choicesAt, take, explore } from '../src/js/testmode.js';

function dialogue() {
  const m = new GraphModel();
  const node = (text, data = {}) => m.addNode({ x: 0, y: 0, text, data });
  const hello = node('Ciao, chi sei?', { start: 'yes', set: 'coins = 2' });
  const shop = node('Vuoi comprare?');
  const rich = node('Ecco la spada.', { set: 'coins = coins - 3' });
  const poor = node('Non hai abbastanza monete.');
  const bye = node('Arrivederci.');
  const edge = (a, b, label, data = {}) => m.addEdge({ from: a.id, to: b.id, label, data });
  edge(hello, shop, 'Un viaggiatore', { set: 'name = "viaggiatore"; coins = coins + 1' });
  edge(hello, bye, 'Nessuno');
  edge(shop, rich, 'Sì', { if: 'coins >= 3' });
  edge(shop, poor, 'Sì', { if: 'coins < 3' });
  edge(shop, bye, 'No');
  edge(poor, shop, 'Torna indietro');
  return { m, hello, shop, rich, poor, bye };
}

describe('Test mode', () => {
  it('formulas only calculate, with the variables as names', () => {
    const vars = new Map([['SCORE', 3], ['NAME', 'Ada']]);
    expect(calculate('score > 2', vars)).toBe(true);
    expect(calculate('=IF(name="Ada",score*2,0)', vars)).toBe(6);
    expect(calculate('A1+1', vars)).toBe('#REF!');
    expect(calculate('nonsense(', vars)).toBe('#VALUE!');
    expect(assignments('x = 1; s = "a;b"; A1 = 2; bad')).toEqual([{ name: 'X', formula: '1' }, { name: 'S', formula: '"a;b"' }]);
    expect([...applySet('a = 2; b = a * 10', new Map())]).toEqual([['A', 2], ['B', 20]]);
  });

  it('a walk starts where marked, offers only the answers whose condition holds, and carries values along', () => {
    const { m, hello, shop, rich } = dialogue();
    expect(startNode(m)).toBe(hello.id);
    let state = { node: hello.id, variables: applySet(hello.data.set, new Map()) };
    const first = choicesAt(m, state.node, state.variables).filter((c) => c.open);
    state = take(m, first.find((c) => c.label === 'Un viaggiatore').edge, state.variables);
    expect(state.node).toBe(shop.id);
    expect(state.variables.get('COINS')).toBe(3);
    const open = choicesAt(m, shop.id, state.variables).filter((c) => c.open);
    expect(open.map((c) => c.edge.to)).toContain(rich.id);
    state = take(m, open.find((c) => c.edge.to === rich.id).edge, state.variables);
    expect(state.variables.get('COINS')).toBe(0);
  });

  it('every way through is walked: the endings, the loops, and a node where no answer is open', () => {
    const { m, rich, bye, shop } = dialogue();
    const report = explore(m, startNode(m));
    expect([...report.endings.keys()].sort()).toEqual([rich.id, bye.id].sort());
    expect(report.stuck.size).toBe(0);
    // With no coin given on the way, the shop sends the traveller back round: a loop, followed once.
    m.edges.find((e) => e.label === 'Un viaggiatore').data.set = 'coins = coins + 0';
    const poorer = explore(m, startNode(m));
    expect(poorer.loops).toBeGreaterThan(0);
    expect(poorer.endings.has(rich.id)).toBe(false);
    // Closing the only way out leaves the walk stuck at the shop, and that is named.
    m.edges.find((e) => e.from === shop.id && e.label === 'No').data.if = 'FALSE()';
    m.edges.find((e) => e.data?.if === 'coins < 3').data.if = 'coins < 0';
    expect(explore(m, startNode(m)).stuck.has(shop.id)).toBe(true);
  });
});
