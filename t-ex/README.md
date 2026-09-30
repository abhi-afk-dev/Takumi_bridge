# Takumi VS Code Bridge 🌉🤖

The official IDE integration for Takumi — your personal, multi-agent AI dev team.

This extension is a secure, high-speed WebSocket bridge between your local VS Code environment and the Takumi AI engine. It lets Takumi's specialized agents (Co-founder, Product Manager, MVP, Frontend, Backend, and DevOps) see your project and write code directly into your editor in real time.

## ✨ Features

- **Real-Time Workspace Sync** — Takumi instantly reads your project's file structure, so it always knows exactly what you're working on.
- **Smart Context Filtering** — automatically ignores heavy, irrelevant folders like `node_modules`, `venv`, and `.git` to save on tokens and keep the AI focused on your actual source code.
- **Direct Code Injection** — Takumi's agents create folders, scaffold boilerplate, and write multi-file features straight onto your disk. No copy-pasting.
- **Automated Terminal Commands** — Takumi can run the commands your project needs (`npm install`, `pip install -r requirements.txt`, starting dev servers, etc.).
- **Self-Healing (Auto-Fix)** — when something breaks, the Healer Agent reads your files and terminal output to diagnose and fix it automatically.

## 🚀 How It Works

Takumi isn't a generic chatbot; it's a team of agents. This extension gives that team "hands and eyes" on your local machine.

1. You describe what you want in the Takumi Web App (e.g., "Build a SaaS to help freelancer manage there clients and projects").
2. The Takumi backend turns that into an execution plan.
3. This extension receives that plan and safely carries it out in your active VS Code workspace.

## 📝 Requirements & Setup

1. Open your project folder in VS Code.
2. Log in at [app.takumi.run/login](https://app.takumi.run/login) and set your working directory on the Takumi dashboard.
3. Generate a Takumi API key from the dashboard.
4. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Takumi: Login**, then paste your key.
5. Open the Takumi web interface in your browser and start chatting — it connects to your VS Code session automatically.

If the connection ever drops or you need to reconnect manually, run **Takumi: Connect** from the Command Palette.

## 🔒 Security & Safety

- **You own everything.** Every project and every line of code created through Takumi belongs to you. Takumi doesn't claim ownership of anything it helps build.
- **Workspace-bound file access.** Every file read, write, and edit is resolved against your currently open workspace root, and anything that would land outside it (via `../` traversal or an absolute path) is blocked before it touches disk.
- **Cross-workspace protection.** Instructions are tagged with the workspace they were generated for; if that doesn't match your currently open workspace, the instruction is rejected outright.
- **Terminal commands run with your authenticated session.** Commands are only ever accepted from your own authenticated backend connection — the same trust model used by other AI coding agents that can run terminal commands on your behalf.

## 💬 Feedback & Support

This is an early Alpha release. If you run into issues, please open an issue or reach out to the development team directly — feedback at this stage genuinely shapes what gets built next.