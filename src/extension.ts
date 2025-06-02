import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { encoding_for_model, get_encoding } from "tiktoken";

export function activate(context: vscode.ExtensionContext) {
  // persisted toggles / options
  let toggleRelativePath = context.globalState.get("toggleRelativePath", true);

  /* ───────────────────────── helpers ───────────────────────── */

  /**
   * Returns either a workspace-relative path or just the basename,
   * depending on the toggle and whether the file is inside a workspace folder.
   */
  function formatPath(fullPath: string): string {
    if (!toggleRelativePath) {
      return path.basename(fullPath);
    }
    const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fullPath));
    return ws ? path.relative(ws.uri.fsPath, fullPath) : path.basename(fullPath);
  }

  /**
   * Copy arbitrary text to clipboard with consistent UX.
   */
  async function copyToClipboard(text: string, okMsg: string) {
    try {
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(okMsg);
    } catch (err) {
      console.error(err);
      vscode.window.showErrorMessage("Failed to write to clipboard");
    }
  }

  /**
   * Expands a folder **one level** to its direct-child files.
   * Skips expansion when the folder is “shadowed” by a deeper explicit selection.
   */
  function expandFolder(
    folder: vscode.Uri,
    selectedPaths: Set<string>
  ): vscode.Uri[] {
    const folderPath = folder.fsPath;
    const isShadowed = Array.from(selectedPaths).some(
      p => p !== folderPath && p.startsWith(folderPath + path.sep)
    );
    if (isShadowed) {
      return []; // a descendant was explicitly picked → let that override
    }

    try {
      return fs
        .readdirSync(folderPath, { withFileTypes: true })
        .filter(d => d.isFile())
        .map(d => vscode.Uri.file(path.join(folderPath, d.name)));
    } catch (e) {
      console.error(`expandFolder failed for ${folderPath}`, e);
      return [];
    }
  }

  /**
   * Calculates an approximate token count using tiktoken.
   * Falls back to UTF-8 byte length / 4 if tiktoken is unavailable.
   */
  function countTokens(text: string): number {
    try {
      const enc = encoding_for_model("gpt-4o-mini") ?? get_encoding("cl100k_base");
      return enc.encode(text).length;
    } catch {
      return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
    }
  }

  /* ──────────────────────── commands ──────────────────────── */

  // 1. Toggle relative-path mode
  context.subscriptions.push(
    vscode.commands.registerCommand("copy-for-llm.toggleRelativePath", () => {
      toggleRelativePath = !toggleRelativePath;
      context.globalState.update("toggleRelativePath", toggleRelativePath);
      vscode.window.showInformationMessage(
        toggleRelativePath ? "Relative paths enabled." : "Relative paths disabled."
      );
    })
  );

  // 2. Copy files / folders selected in Explorer
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copy-for-llm.copySelectedFiles",
      async (uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined) => {
        /* ─────────── gather selection ─────────── */
        const raw = uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor
          ? [vscode.window.activeTextEditor.document.uri]
          : [];

        if (raw.length === 0) {
          vscode.window.showErrorMessage("No files or folders selected.");
          return;
        }

        const selectedPathSet = new Set(raw.map(u => u.fsPath));
        const targets: vscode.Uri[] = [];

        for (const u of raw) {
          try {
            const stat = fs.statSync(u.fsPath);
            if (stat.isFile()) {
              targets.push(u);
            } else if (stat.isDirectory()) {
              targets.push(
                ...expandFolder(u, selectedPathSet)
              );
            }
          } catch (e) {
            console.error(`Stat failed for ${u.fsPath}`, e);
          }
        }

        if (targets.length === 0) {
          vscode.window.showErrorMessage("Nothing to copy (no readable files).");
          return;
        }

        /* ─────────── build buffer & token counts ─────────── */
        const perFileTokens: { path: string; tokens: number; body: string }[] = [];
        let totalTokens = 0;

        for (const u of targets) {
          try {
            const content = fs.readFileSync(u.fsPath, "utf8");
            const tks = countTokens(content);
            perFileTokens.push({ path: formatPath(u.fsPath), tokens: tks, body: content });
            totalTokens += tks;
          } catch (err) {
            console.error(err);
            vscode.window.showWarningMessage(`Could not read: ${u.fsPath}`);
          }
        }

        if (perFileTokens.length === 0) {
          vscode.window.showErrorMessage("Nothing copied (all reads failed).");
          return;
        }

        /* ─────────── summary header (config-driven) ─────────── */
        const cfg = vscode.workspace.getConfiguration("copyForLlm");
        const summaryMode = cfg.get<"auto" | "always" | "off">("summaryMode", "auto");
        const summaryThreshold = cfg.get<number>("summaryThresholdTokens", 50000);

        let buffer = "";

        const wantSummary =
          summaryMode === "always" ||
          (summaryMode === "auto" && totalTokens > summaryThreshold);

        if (wantSummary) {
          buffer += "### Selection summary (approx.):\n";
          perFileTokens.forEach(f => {
            buffer += `• ${f.path}  (~${f.tokens.toLocaleString()} tk)\n`;
          });
          buffer += "\n";
        }

        perFileTokens.forEach(f => {
          buffer += `${f.path}:\n\`\`\`\n${f.body}\n\`\`\`\n\n`;
        });

        /* ─────────── oversize warning ─────────── */
        if (totalTokens > 200_000) {
          vscode.window.showWarningMessage(
            `⚠ Copied text is ~${totalTokens.toLocaleString()} tokens – many LLMs will truncate or reject input this large.`
          );
        }

        await copyToClipboard(buffer, "Selected content copied to clipboard");
      }
    )
  );
}

export function deactivate() {}
