// Browser bundle entry point. Parsing is Node-native (tree-sitter), so the browser
// never parses — it loads a pre-lowered module AST (emitted by `velve ast`) and
// interprets it. This file re-exports exactly the runtime the served page needs;
// `esbuild --bundle --platform=browser` rolls it + its Node-free dependency graph
// (eval/browser/render/converge/runtime/value/scheduler) into one `web/app.js`.
export { Evaluator } from "./eval.js";
export { mountLive, hydrate } from "./browser.js";
