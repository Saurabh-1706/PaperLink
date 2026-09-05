/**
 * `pdfjs-dist` ships type declarations for its main build but not for the worker
 * entry point, so importing the worker directly is an implicit-any error.
 *
 * That import exists to make Vercel's file tracer aware of pdf.worker.mjs — see the
 * long comment in lib/server/modules/documents/pdf.ts. The module's only meaningful
 * export is `WorkerMessageHandler`, which pdfjs looks up itself off
 * `globalThis.pdfjsWorker`; nothing in this codebase calls into it directly, hence
 * `unknown` rather than a hand-written signature that would only rot.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
