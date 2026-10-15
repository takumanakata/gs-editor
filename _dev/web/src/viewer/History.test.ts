import { describe, it, expect } from "vitest";
import { History } from "./History";

function counterHistory() {
  let value = 0;
  const h = new History();
  const add = (n: number) => { value += n; h.push({ label: `+${n}`, undo: () => (value -= n), redo: () => (value += n) }); };
  return { h, add, get value() { return value; } };
}

describe("History", () => {
  it("undoes and redoes in order, and a new edit discards the future", () => {
    const c = counterHistory();
    c.add(1); c.add(2); c.add(4);
    expect(c.value).toBe(7);
    c.h.undo(); c.h.undo();
    expect(c.value).toBe(1);
    expect(c.h.rows.map((r) => r.applied)).toEqual([true, false, false]);
    c.h.redo();
    expect(c.value).toBe(3);
    c.add(8); // discards "+4"
    expect(c.value).toBe(11);
    expect(c.h.rows.map((r) => r.label)).toEqual(["+1", "+2", "+8"]);
    expect(c.h.canRedo).toBe(false);
  });

  it("goTo jumps across several steps either way", () => {
    const c = counterHistory();
    for (let i = 0; i < 5; i++) c.add(1);
    c.h.goTo(0); expect(c.value).toBe(0);
    c.h.goTo(5); expect(c.value).toBe(5);
    c.h.goTo(2); expect(c.value).toBe(2);
    expect(c.h.position).toBe(2);
  });

  it("drops the oldest steps beyond MAX and counts them", () => {
    const c = counterHistory();
    for (let i = 0; i < History.MAX + 3; i++) c.add(1);
    expect(c.h.length).toBe(History.MAX);
    expect(c.h.dropped).toBe(3);
    c.h.goTo(0); // can only go back to the oldest kept step
    expect(c.value).toBe(3);
  });
});
