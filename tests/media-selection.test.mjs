import assert from "node:assert/strict";
import test from "node:test";

import { toggleMarqueeSelection } from "../app/media-selection.mjs";

test("first marquee selects every unselected asset inside the rectangle", () => {
  assert.deepEqual(toggleMarqueeSelection([], [2, 3, 4]), [2, 3, 4]);
});

test("repeating the same marquee deselects the selected assets", () => {
  const first = toggleMarqueeSelection([], [2, 3, 4]);
  assert.deepEqual(toggleMarqueeSelection(first, [2, 3, 4]), []);
});

test("a later marquee toggles only assets inside it and preserves everything outside", () => {
  assert.deepEqual(toggleMarqueeSelection([1, 2, 5], [2, 3, 4]), [1, 5, 3, 4]);
});
