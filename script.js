"use strict";

const SCALE = 4;
const DEBOUNCE_MS = 150;
const SVG_NS = "http://www.w3.org/2000/svg";

const presets = {
  "rsa-encryption": String.raw`c \equiv m^e \pmod n`,
  "rsa-decryption": String.raw`m \equiv c^d \pmod n`,
  "euler-totient": String.raw`\phi(n) = (p-1)(q-1)`,
  "ecdsa-signature": String.raw`s \equiv k^{-1}(H(m) + dr) \pmod n`,
  "elliptic-curve": String.raw`y^2 \equiv x^3 + ax + b \pmod p`,
  "modular-inverse": String.raw`a^{-1}a \equiv 1 \pmod n`,
  polynomial: String.raw`f(x) = \sum_{i=0}^{n} a_i x^i`,
  matrix: String.raw`\begin{bmatrix}
a & b \\
c & d
\end{bmatrix}`
};

function wrapEquation(latex, display) {
  const delimiter = display ? "$$" : "$";
  return `${delimiter}${latex}${delimiter}`;
}

function parseEquationSource(source) {
  const value = source.trim();
  const delimiter = value.startsWith("$$") ? "$$" : value.startsWith("$") ? "$" : null;
  if (!delimiter || !value.endsWith(delimiter) ||
      (delimiter === "$" && value.endsWith("$$"))) {
    throw new Error("Wrap the equation in $$...$$ for Display or $...$ for Inline.");
  }

  const latex = value.slice(delimiter.length, -delimiter.length).trim();
  if (!latex) throw new Error("Enter an equation between the dollar signs.");
  return { latex, display: delimiter === "$$" };
}

const input = document.querySelector("#latex-input");
let isUntouchedExample = input.value === input.defaultValue;
const preview = document.querySelector("#equation-preview");
const errorMessage = document.querySelector("#error-message");
const status = document.querySelector("#status");
const presetSelect = document.querySelector("#preset-select");
const copyImageButton = document.querySelector("#copy-image");
const downloadButton = document.querySelector("#download-png");

let changeVersion = 0;
let renderedVersion = -1;
let debounceTimer;
let statusTimer;
let renderQueue = Promise.resolve();
let cachedPngBlob = null;
let pngPromise = null;

function showStatus(message, isError = false) {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.toggle("is-error", isError);
  statusTimer = setTimeout(() => { status.textContent = ""; }, 1800);
}

function setError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}

function setImageActionsEnabled(enabled) {
  copyImageButton.disabled = !enabled;
  downloadButton.disabled = !enabled;
}

function queueRender(immediate = false) {
  const version = ++changeVersion;
  clearTimeout(debounceTimer);
  preview.classList.remove("is-selected");
  renderedVersion = -1;
  cachedPngBlob = null;
  pngPromise = null;
  setImageActionsEnabled(false);
  setError("");

  const schedule = () => {
    // MathJax 3 conversions share internal state, so they must run in sequence.
    renderQueue = renderQueue.catch(() => {}).then(() => renderEquation(version));
  };
  if (immediate) schedule();
  else debounceTimer = setTimeout(schedule, DEBOUNCE_MS);
}

async function renderEquation(version) {
  if (version !== changeVersion) return;

  const latex = input.value;
  if (!latex.trim()) {
    preview.classList.remove("inline");
    preview.replaceChildren(makePlaceholder("Enter LaTeX to see an equation."));
    return;
  }

  if (!window.MathJax?.tex2svgPromise) {
    preview.replaceChildren(makePlaceholder("MathJax could not load."));
    setError("MathJax could not load. Check your internet connection and reload the page.");
    return;
  }

  try {
    const equation = parseEquationSource(latex);
    const { display } = equation;
    document.querySelector(`input[name="mode"][value="${display ? "display" : "inline"}"]`).checked = true;
    const metrics = MathJax.getMetricsFor(preview, display);
    const result = await MathJax.tex2svgPromise(equation.latex, { ...metrics, display });
    if (version !== changeVersion) return;

    const svg = result.querySelector("svg");
    if (!svg) throw new Error("MathJax did not return an SVG equation.");

    preview.classList.toggle("inline", !display);
    preview.replaceChildren(result);
    renderedVersion = version;
    setImageActionsEnabled(true);
    setError("");
  } catch (error) {
    if (version !== changeVersion) return;
    preview.classList.remove("inline");
    preview.replaceChildren(makePlaceholder("Fix the LaTeX to update the preview."));
    setError(error?.message || "The equation could not be rendered.");
  }
}

function makePlaceholder(message) {
  const span = document.createElement("span");
  span.className = "placeholder";
  span.textContent = message;
  return span;
}

function svgToPng(svg) {
  const box = svg.getBoundingClientRect();
  if (!box.width || !box.height) return Promise.reject(new Error("Equation has no visible size."));

  const width = Math.ceil(box.width * SCALE);
  const height = Math.ceil(box.height * SCALE);
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("width", `${box.width}px`);
  clone.setAttribute("height", `${box.height}px`);
  clone.setAttribute("color", "#1f252b");
  clone.style.color = "#1f252b";

  const xml = new XMLSerializer().serializeToString(clone);
  const svgUrl = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(svgUrl);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return reject(new Error("Canvas is unavailable."));
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.scale(SCALE, SCALE);
      context.drawImage(image, 0, 0, box.width, box.height);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("PNG export failed."));
      }, "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(svgUrl);
      reject(new Error("Could not convert the equation SVG to PNG."));
    };
    image.src = svgUrl;
  });
}

function generatePngBlob() {
  if (cachedPngBlob) return Promise.resolve(cachedPngBlob);
  if (pngPromise) return pngPromise;
  if (renderedVersion !== changeVersion) return Promise.reject(new Error("The preview is still updating."));

  const svg = preview.querySelector("svg");
  if (!svg) return Promise.reject(new Error("There is no equation to export."));

  const version = renderedVersion;
  pngPromise = svgToPng(svg).then(blob => {
    if (version !== changeVersion) throw new Error("The equation changed. Try again.");
    cachedPngBlob = blob;
    return blob;
  }).finally(() => {
    if (version === changeVersion) pngPromise = null;
  });
  return pngPromise;
}

async function copyEquationImage() {
  if (renderedVersion !== changeVersion) {
    showStatus("Wait for the equation preview to update.", true);
    return;
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined" ||
      (ClipboardItem.supports && !ClipboardItem.supports("image/png"))) {
    showStatus("Image clipboard is unsupported. Use Download PNG instead.", true);
    return;
  }

  try {
    // Pass the Blob promise directly so clipboard.write starts during the user gesture.
    const png = cachedPngBlob || generatePngBlob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    showStatus("Equation copied as image");
  } catch (error) {
    showStatus("Clipboard access failed. Use Download PNG instead.", true);
  }
}

async function copyLatex() {
  if (!navigator.clipboard?.writeText) {
    showStatus("Text clipboard is unavailable in this browser.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(input.value);
    showStatus("LaTeX copied");
  } catch (error) {
    showStatus("Clipboard access failed.", true);
  }
}

async function downloadPng() {
  try {
    const blob = await generatePngBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "equation.png";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus("PNG downloaded");
  } catch (error) {
    showStatus(error?.message || "PNG download failed.", true);
  }
}

input.addEventListener("paste", event => {
  const pastedText = event.clipboardData?.getData("text/plain");
  if (!pastedText) {
    if ([...(event.clipboardData?.items || [])].some(item => item.type.startsWith("image/"))) {
      showStatus("Clipboard contains an image. Paste LaTeX text here.", true);
    }
    return;
  }

  // Let the browser perform its normal paste, replacing only the untouched starter example.
  if (isUntouchedExample && input.selectionStart === input.selectionEnd) input.select();
});
input.addEventListener("input", () => {
  isUntouchedExample = false;
  queueRender();
});
document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener("change", () => {
    if (input.value.trim()) {
      try {
        const { latex } = parseEquationSource(input.value);
        input.value = wrapEquation(latex, radio.value === "display");
        isUntouchedExample = false;
      } catch (error) {
        // Keep incomplete input editable; the preview will show the delimiter error.
      }
    }
    queueRender(true);
  });
});
presetSelect.addEventListener("change", () => {
  if (!presetSelect.value) return;
  const display = document.querySelector('input[name="mode"]:checked').value === "display";
  input.value = wrapEquation(presets[presetSelect.value], display);
  isUntouchedExample = false;
  queueRender(true);
  input.focus();
});
document.querySelector("#copy-latex").addEventListener("click", copyLatex);
copyImageButton.addEventListener("click", copyEquationImage);
downloadButton.addEventListener("click", downloadPng);
document.querySelector("#clear-input").addEventListener("click", () => {
  input.value = "";
  isUntouchedExample = false;
  presetSelect.value = "";
  queueRender(true);
  input.focus();
});
function selectEquation() {
  if (!preview.querySelector("svg")) return;
  preview.classList.add("is-selected");
  preview.focus({ preventScroll: true });
}

preview.addEventListener("pointerdown", event => {
  if (event.button === 0) selectEquation();
});
preview.addEventListener("click", selectEquation);
preview.addEventListener("focusout", event => {
  if (!preview.contains(event.relatedTarget)) preview.classList.remove("is-selected");
});
preview.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    copyEquationImage();
  }
});

if (window.MathJax?.startup?.promise) {
  MathJax.startup.promise.then(() => {
    // Direct tex2svgPromise conversion does not insert MathJax's SVG stylesheet.
    if (!document.querySelector("#MJX-SVG-styles")) {
      document.head.appendChild(MathJax.svgStylesheet());
    }
    queueRender(true);
  }).catch(() => {
    preview.replaceChildren(makePlaceholder("MathJax could not load."));
    setError("MathJax could not load. Check your internet connection and reload the page.");
  });
} else {
  preview.replaceChildren(makePlaceholder("MathJax could not load."));
  setError("MathJax could not load. Check your internet connection and reload the page.");
}
