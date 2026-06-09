"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = require("path");
const vscode = require("vscode");
const node_1 = require("vscode-languageclient/node");
let client;
function activate(context) {
    const cfg = vscode.workspace.getConfiguration("velve");
    const checkerDir = cfg.get("serverPath") ||
        "/home/velasco/workspaces/velve/checker";
    const serverModule = path.join(checkerDir, "dist", "lsp.js");
    const serverOptions = {
        run: { command: "node", args: [serverModule, "--stdio"] },
        debug: { command: "node", args: ["--nolazy", "--inspect=6009", serverModule, "--stdio"] },
    };
    const clientOptions = {
        documentSelector: [{ scheme: "file", language: "velve" }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher("**/*.velve"),
        },
    };
    client = new node_1.LanguageClient("velve", "Velve Language Server", serverOptions, clientOptions);
    client.start();
    context.subscriptions.push(client);
}
function deactivate() {
    return client?.stop();
}
