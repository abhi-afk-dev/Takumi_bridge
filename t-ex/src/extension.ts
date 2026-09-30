import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";

let socket: WebSocket | null = null;
let reconnectInterval: NodeJS.Timeout | null = null;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Takumi Bridge");
  outputChannel.show();

  let loginDisposable = vscode.commands.registerCommand(
    "takumi.login",
    async () => {
      const b64Key = await vscode.window.showInputBox({
        prompt: "Paste your Takumi Access Key",
        password: true,
        ignoreFocusOut: true,
      });

      if (b64Key) {
        try {
          const rawKey = Buffer.from(b64Key, "base64").toString("utf-8");

          const parts = rawKey.split("___");
          if (parts.length !== 3) throw new Error("Invalid Format");

          await context.secrets.store("takumi_api_key", parts[0]);
          await context.secrets.store("takumi_hf_token", parts[1]);
          await context.secrets.store("takumi_backend_url", parts[2]);

          vscode.window.showInformationMessage(
            "Takumi: Successfully authenticated!",
          );
          connectToBackend(context);
        } catch (error) {
          vscode.window.showErrorMessage("Invalid Takumi Access Key.");
        }
      }
    },
  );

  context.subscriptions.push(loginDisposable);

  let connectDisposable = vscode.commands.registerCommand(
    "takumi.connect",
    () => {
      log("🔄 Manual Reconnect Triggered...");

      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
      }

      if (socket) {
        const oldSocket = socket;
        socket = null;
        oldSocket.close();
      }

      connectToBackend(context);
    },
  );
  context.subscriptions.push(connectDisposable);

  const existingKey = await context.secrets.get("takumi_api_key");

  if (existingKey) {
    connectToBackend(context);
  } else {
    log("⚠️ No API key found. Launching first-time setup...");
    vscode.window.showInformationMessage(
      "Welcome to Takumi! Let's get you connected to the cloud.",
    );
    vscode.commands.executeCommand("takumi.login");
  }
}

export function deactivate() {
  if (socket) {
    socket.close();
  }
  if (reconnectInterval) {
    clearInterval(reconnectInterval);
  }
}

// ---------------------------------------------------------
// 1. CONNECTION MANAGER
// ---------------------------------------------------------

async function connectToBackend(context: vscode.ExtensionContext) {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const apiKey = await context.secrets.get("takumi_api_key");
  const hfToken = await context.secrets.get("takumi_hf_token");
  const savedDomain = await context.secrets.get("takumi_backend_url");

  if (!apiKey || !hfToken || !savedDomain) {
    log("❌ Connection blocked: Missing authentication components.");
    return;
  }

  let cleanDomain = savedDomain.replace(/^(wss?|https?):\/\//, "");
  cleanDomain = cleanDomain.split("/")[0];

  const wsUrl = `wss://${cleanDomain}/ws/bridge/?token=${apiKey}`;

  socket = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Bearer ${hfToken}`,
      Origin: `https://${cleanDomain}`,
    },
  });

  const activeSocket = socket;

  activeSocket.on("open", () => {
    if (socket !== activeSocket) return;

    vscode.window.setStatusBarMessage("Takumi: Connected", 5000);
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }

    const pingInterval = setInterval(() => {
      if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: "heartbeat" }));
      } else {
        clearInterval(pingInterval);
      }
    }, 20000);
  });

  activeSocket.on("message", async (data) => {
    if (socket !== activeSocket) return;
    try {
      const message = JSON.parse(data.toString());
      await handleInstruction(message);
    } catch (e) {
      log(`❌ Error parsing message: ${e}`);
    }
  });

  activeSocket.on("close", () => {
    if (socket === activeSocket) {
      log("⚠️ Disconnected. Retrying in 5s...");
      socket = null;
      if (!reconnectInterval) {
        reconnectInterval = setInterval(() => connectToBackend(context), 5000);
      }
    }
  });

  activeSocket.on("error", (err) => {
    if (socket === activeSocket) {
      let safeError = err.message || "Unknown connection error";
      if (cleanDomain && safeError.includes(cleanDomain)) {
        safeError = safeError.replace(cleanDomain, "[TAKUMI_SECURE_SERVER]");
      }
      log(`❌ Connection Error: ${safeError}`);
    }
  });
}

function send(payload: any) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------
// 2. THE ROUTER (RUTHLESS BOUNCER)
// ---------------------------------------------------------

function normalizePath(p: string): string {
  if (!p) return "";
  let cleaned = p.replace(/\\/g, "/");
  if (cleaned.endsWith("/")) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned.toLowerCase();
}

// ---------------------------------------------------------
// 2b. PATH SANDBOX (actually enforces what the README claims)
// ---------------------------------------------------------

/**
 * Resolves a requested path (relative or absolute) against the workspace
 * root and returns null if the result would land outside the workspace.
 * This is the single choke point every file/dir operation must go through.
 */
function resolveSafePath(
  workspaceRoot: string,
  requestedPath: string,
): string | null {
  if (!workspaceRoot || !requestedPath) return null;

  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.join(workspaceRoot, requestedPath);

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedCandidate = path.resolve(candidate);

  const isInside =
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + path.sep);

  return isInside ? resolvedCandidate : null;
}

async function handleInstruction(instruction: any) {
  const currentWorkspace = getWorkspaceRoot();
  const normCurrent = normalizePath(currentWorkspace);

  let targetWorkspace = null;
  if (Array.isArray(instruction) && instruction.length > 0) {
    targetWorkspace = instruction[0].target_workspace;
  } else if (instruction.target_workspace) {
    targetWorkspace = instruction.target_workspace;
  }

  if (targetWorkspace) {
    const normTarget = normalizePath(targetWorkspace);

    if (normTarget !== normCurrent) {
      log(`🛡️ Blocked cross-workspace payload.`);
      log(`👉 Expected: '${normCurrent}'`);
      log(`👉 Got: '${normTarget}'`);
      return;
    }
  } else {
    if (
      Array.isArray(instruction) &&
      instruction.length > 0 &&
      (instruction[0].action || instruction[0].command)
    ) {
      log(
        `🚫 FATAL: Blocked UNTAGGED execution array. Prevented AI Cannibalism!`,
      );
      log(
        `👉 Fix: Ensure your backend sets 'target_workspace' on ALL payloads.`,
      );
      return;
    }
  }

  if (instruction.request_id) {
    log(
      `📩 Received Request: ${instruction.command} [ID: ${instruction.request_id.substring(0, 4)}]`,
    );
    await handleRequest(instruction);
    return;
  }

  if (
    Array.isArray(instruction) &&
    instruction.length > 0 &&
    instruction[0].action
  ) {
    log(`📦 Received Execution Plan (${instruction.length} steps)`);
    await executePlan(instruction);
    return;
  }

  if (
    Array.isArray(instruction) &&
    instruction.length > 0 &&
    instruction[0].command
  ) {
    log(`✏️ Received Code Edits (${instruction.length} edits)`);
    const success = await processEdits(instruction);
    send({ type: "execution_result", success: success });
    return;
  }

  if (instruction.verification_instruction) {
    log("🕵️ Received Verification Request");
    await executeStep(instruction.verification_instruction);
    return;
  }
  if (instruction.execution_plan) {
    await executePlan(instruction.execution_plan);
    return;
  }

  log("⚠️ Unknown instruction format ignored.");
}

// ---------------------------------------------------------
// 3. REQUEST HANDLERS (The Scout Logic)
// ---------------------------------------------------------

async function handleRequest(request: any) {
  const reqId = request.request_id;
  try {
    let resultData = null;
    if (request.command === "get_file_tree") {
      log(" 🔎 Scanning workspace for files...");
      const files = await getProjectFiles();
      resultData = files;
      log(` ✅ Found ${files.length} files.`);
    } else if (request.command === "read_files") {
      log(` 📖 Reading ${request.paths.length} files...`);
      resultData = await readSpecificFiles(request.paths);
    } else if (request.command === "get_system_info") {
      log(" 💻 Sending System Info...");
      resultData = {
        os: process.platform,
        workspaceRoot: getWorkspaceRoot(),
      };
    }

    send({
      request_id: reqId,
      data: resultData,
      status: "success",
    });
  } catch (error: any) {
    log(`❌ Request Failed: ${error}`);
    send({
      request_id: reqId,
      error: error.message,
      status: "error",
    });
  }
}

async function getProjectFiles(): Promise<string[]> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return [];
  const uris = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,.git,dist,build,env,venv,__pycache__,.DS_Store}/**",
  );

  const relativePaths = uris.map((uri) =>
    path.relative(workspaceRoot, uri.fsPath),
  );

  return relativePaths.map((p) => p.split(path.sep).join("/"));
}

async function readSpecificFiles(
  paths: string[],
): Promise<{ [key: string]: string }> {
  const workspaceRoot = getWorkspaceRoot();
  const contents: { [key: string]: string } = {};
  for (const relPath of paths) {
    try {
      const safePath = resolveSafePath(workspaceRoot, relPath);
      if (!safePath) {
        log(` 🛡️ Blocked read outside workspace: ${relPath}`);
        continue;
      }
      if (fs.existsSync(safePath)) {
        contents[relPath] = fs.readFileSync(safePath, "utf8");
      }
    } catch (e) {
      log(` ⚠️ Failed to read ${relPath}`);
    }
  }

  return contents;
}

// ---------------------------------------------------------
// 4. PLAN EXECUTOR & FILE OPS
// ---------------------------------------------------------
async function executePlan(plan: any[]) {
  for (const step of plan) {
    try {
      await executeStep(step);
    } catch (error) {
      log(`❌ Plan Halted: ${error}`);
      break;
    }
  }
  log("✨ Plan Execution Finished.");
}

async function executeStep(step: any) {
  const workspaceRoot = getWorkspaceRoot();

  if (step.action === "shell") {
    const cmd = step.command;

    let cwd = workspaceRoot;
    if (step.cwd) {
      const safeCwd = resolveSafePath(workspaceRoot, step.cwd);
      if (!safeCwd) {
        log(
          `🛡️ Blocked shell command: cwd '${step.cwd}' is outside the workspace.`,
        );
        return;
      }
      cwd = safeCwd;
    }

    log(`>_ Running: ${cmd}`);
    const terminalOptions: vscode.TerminalOptions = {
      name: "Takumi Agent",
      cwd: cwd,
    };
    if (process.platform === "win32") {
      terminalOptions.shellPath = "C:\\Windows\\System32\\cmd.exe";
    }
    const terminal = vscode.window.createTerminal(terminalOptions);
    terminal.show();
    await new Promise((r) => setTimeout(r, 15000));
    terminal.sendText(cmd);
    await new Promise((r) => setTimeout(r, 15000));
  } else if (step.action === "write") {
    const safePath = resolveSafePath(workspaceRoot, step.path);
    if (!safePath) {
      log(`🛡️ Blocked write outside workspace: ${step.path}`);
      return;
    }
    log(`📝 Writing: ${step.path}`);
    await ensureDirectory(safePath);
    fs.writeFileSync(safePath, step.content, "utf8");
  } else if (step.action === "mkdir") {
    const safePath = resolveSafePath(workspaceRoot, step.path);
    if (!safePath) {
      log(`🛡️ Blocked mkdir outside workspace: ${step.path}`);
      return;
    }
    if (!fs.existsSync(safePath)) fs.mkdirSync(safePath, { recursive: true });
  } else if (step.action === "log") {
    log(`🤖 ${step.message}`);
    vscode.window.showInformationMessage(step.message);
  }
}

async function processEdits(edits: any[]): Promise<boolean> {
  const workspaceEdit = new vscode.WorkspaceEdit();
  const workspaceRoot = getWorkspaceRoot();
  let useFsOverride = false;
  for (const data of edits) {
    if (!data.filePath) continue;

    const fullPath = resolveSafePath(workspaceRoot, data.filePath);
    if (!fullPath) {
      log(`🛡️ Blocked edit outside workspace: ${data.filePath}`);
      continue;
    }

    const uri = vscode.Uri.file(fullPath);
    if (
      data.command === "replace" &&
      (!data.startLine || data.startLine === 0) &&
      (!data.endLine || data.endLine > 10000)
    ) {
      log(`⚡ Atomic Rewrite (FS): ${data.filePath}`);
      await ensureDirectory(fullPath);
      fs.writeFileSync(fullPath, data.code || "", "utf8");
      useFsOverride = true;
      continue;
    }
    if (!fs.existsSync(fullPath)) {
      if (data.command === "insert" || data.command === "replace")
        workspaceEdit.createFile(uri, { ignoreIfExists: true });
      else continue;
    }
    const start = new vscode.Position(data.startLine || 0, 0);
    if (data.command === "insert") {
      workspaceEdit.insert(uri, start, data.code || "");
    } else if (data.command === "replace") {
      let endLine = data.endLine !== undefined ? data.endLine : 999999;
      workspaceEdit.replace(
        uri,
        new vscode.Range(start, new vscode.Position(endLine, 99999)),
        data.code || "",
      );
    }
  }

  if (!useFsOverride && edits.length > 0) {
    return await vscode.workspace.applyEdit(workspaceEdit);
  }
  return true;
}
function getWorkspaceRoot(): string {
  if (
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders.length > 0
  ) {
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  return "";
}
async function ensureDirectory(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
}
function log(msg: string) {
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}
