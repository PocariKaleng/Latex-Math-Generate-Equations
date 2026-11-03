const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the same pure extractor used by the browser, without a DOM dependency.
const source = fs.readFileSync(path.join(__dirname, "../script.js"), "utf8");
const extract = vm.runInNewContext(source.slice(0, source.indexOf('const input = document.querySelector')) + "\nextractAiEquations;");
const read = value => JSON.parse(JSON.stringify(extract(value)));
const fence = String.fromCharCode(96).repeat(3);
const maxwell = fs.readFileSync(path.join(__dirname, "fixtures/deepseek-maxwell.tex"), "utf8").trim().replace(/\r\n/g, "\n");

test("imports the exact bare aligned Maxwell equations from DeepSeek as one formula", () => {
  assert.deepEqual(read(maxwell), [{ latex: maxwell, display: true }]);
  assert.deepEqual(read("Maxwell equations:\n" + maxwell + "\nThen $x=1$."), [
    { latex: maxwell, display: true }, { latex: "x=1", display: false }
  ]);
  assert.deepEqual(read(fence + "latex\n" + maxwell + "\n" + fence), [{ latex: maxwell, display: true }]);
});

test("accepts bare aligned input directly in the manual editor", () => {
  const parse = vm.runInNewContext(source.slice(0, source.indexOf('const input = document.querySelector')) + "\nparseEquationSource;");
  assert.deepEqual(JSON.parse(JSON.stringify(parse(maxwell))), { latex: maxwell, display: true });
  assert.throws(() => parse(maxwell + "\nExplanation"), /Wrap the equation/);
});

test("keeps nested environments intact and rejects mismatched or missing endings", () => {
  const nested = "\\begin{aligned}A &= \\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}\\end{aligned}";
  assert.deepEqual(read(nested), [{ latex: nested, display: true }]);
  assert.throws(() => read("\\begin{aligned}x=1"), /Incomplete LaTeX environment/);
  assert.throws(() => read("\\begin{aligned}x=1\\end{matrix}"), /Mismatched LaTeX environment/);
});

test("extracts display and inline formulas in source order, skipping prose", () => {
  assert.deepEqual(read("First \\(x^2\\), then:\n\\[\ny = \\frac{a}{b}\n\\]\nAlso $z+1$ and $$q=2$$."), [
    { latex: "x^2", display: false },
    { latex: "y = \\frac{a}{b}", display: true },
    { latex: "z+1", display: false },
    { latex: "q=2", display: true }
  ]);
});

test("reads labeled code blocks, preserving matrix rows and backslashes", () => {
  const matrix = "\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}";
  for (const language of ["latex", "tex", "math", "LaTeX"]) {
    assert.deepEqual(read(fence + language + "\r\n" + matrix + "\r\n" + fence), [{ latex: matrix, display: true }]);
  }
});

test("does not double count wrappers inside code blocks", () => {
  assert.deepEqual(read(fence + "latex\n\\[a=b\\]\n" + fence), [{ latex: "a=b", display: true }]);
  assert.deepEqual(read(fence + "\n$$a=b$$\n" + fence), [{ latex: "a=b", display: true }]);
});

test("skips unrelated code, ordinary text, escaped dollars, and currency", () => {
  assert.deepEqual(read(fence + 'javascript\nconst price = "$x$";\n' + fence + "\nFormula: $y$"), [{ latex: "y", display: false }]);
  for (const value of ["", "An explanation without a formula.", "Price: \\$10", "Prices $10 and $20", "$$unfinished", "\\[unfinished"]) {
    assert.deepEqual(read(value), []);
  }
});

test("rejects broken delimiters in labeled blocks", () => {
  assert.throws(() => read(fence + "latex\n\\[a=b\n" + fence), /incomplete math delimiters/);
});

test("limits imported response size and equation count", () => {
  assert.throws(() => read("a".repeat(50001)), /50,000/);
  assert.equal(read("$x$ ".repeat(100)).length, 100);
  assert.throws(() => read("$x$ ".repeat(101)), /100 equations/);
});
