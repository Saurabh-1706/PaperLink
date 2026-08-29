// Copies the pdf.js worker into /public so the browser can load it same-origin
// (avoids relying on a CDN and keeps versions in lockstep with pdfjs-dist).
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const destDir = path.join(__dirname, "..", "public");
const dest = path.join(destDir, "pdf.worker.min.mjs");

if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`Copied pdf.js worker -> ${dest}`);
