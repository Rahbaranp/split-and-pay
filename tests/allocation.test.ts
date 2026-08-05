import assert from "node:assert/strict";
import test from "node:test";
import { allocateExpenseTotals } from "../app/lib/allocation.ts";

test("splits a $90 bill exactly equally among three people", () => {
  const people = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const expenses = [1001, 2002, 3003, 2994].map((cents) => ({ cents, consumers: ["a", "b", "c"], quantities: {} }));
  assert.deepEqual(allocateExpenseTotals(expenses, people, (item) => item.cents), { a: 3000, b: 3000, c: 3000 });
});

test("preserves quantity-weighted shares and every cent", () => {
  const people = [{ id: "a" }, { id: "b" }];
  const expenses = [{ cents: 1000, consumers: ["a", "b"], quantities: { a: 2, b: 1 } }];
  assert.deepEqual(allocateExpenseTotals(expenses, people, (item) => item.cents), { a: 667, b: 333 });
});
