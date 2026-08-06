import assert from "node:assert/strict";
import test from "node:test";
import { minimumPayableTotal, payableTotal } from "../app/lib/payable-total.ts";

test("allows a different total to reduce the tip", () => {
  assert.equal(minimumPayableTotal(10056, 306), 9750);
  assert.equal(payableTotal(10056, 10000), 10000);
});

test("uses the calculated total when no different amount is entered", () => {
  assert.equal(payableTotal(10056, 0), 10056);
});
