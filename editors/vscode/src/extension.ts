import * as path from "path";
import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("velve");
  const checkerDir = cfg.get<string>("serverPath") ||
    "/home/velasco/workspaces/velve/checker";
  const serverModule = path.join(checkerDir, "dist", "lsp.js");

  const serverOptions: ServerOptions = {
    run:   { command: "node", args: [serverModule, "--stdio"] },
    debug: { command: "node", args: ["--nolazy", "--inspect=6009", serverModule, "--stdio"] },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "velve" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.velve"),
    },
  };

  client = new LanguageClient("velve", "Velve Language Server", serverOptions, clientOptions);
  client.start();
  context.subscriptions.push(client);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
