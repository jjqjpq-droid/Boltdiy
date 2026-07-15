#!/usr/bin/env python3
"""
HY3 AI Coding Agent
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Multi-file project generation
• File editing (append / replace / patch)
• Folder & file creation from natural language
• Full conversation memory
• Uses: https://tencent-hy3-preview.hf.space
"""

import requests
import json
import os
import re
import shutil
from pathlib import Path
from datetime import datetime

# ══════════════════════════════════════════
#  CONFIG
# ══════════════════════════════════════════
API_URL    = "https://tencent-hy3-preview.hf.space/gradio_api/call/chat"
WORK_DIR   = Path("workspace")          # all projects live here
SAVE_FILE  = "chat_history.txt"

# ══════════════════════════════════════════
#  COLORS
# ══════════════════════════════════════════
class C:
    RESET   = "\033[0m";  BOLD  = "\033[1m";  DIM   = "\033[2m"
    RED     = "\033[91m"; GREEN = "\033[92m";  YELLOW= "\033[93m"
    BLUE    = "\033[94m"; MAGENTA="\033[95m";  CYAN  = "\033[96m"
    WHITE   = "\033[97m"

def cp(color, text, end="\n"):
    print(f"{color}{text}{C.RESET}", end=end, flush=True)

def clear():
    os.system("cls" if os.name == "nt" else "clear")

# ══════════════════════════════════════════
#  HY3 API  (event-stream style)
# ══════════════════════════════════════════
def hy3_chat(user_msg: str, history: list, show_stream: bool = True) -> str:
    payload = {
        "data": [user_msg, "", history, "high", None, 0, 0, ""]
    }
    answer = ""
    try:
        r = requests.post(API_URL, json=payload, timeout=60)
        r.raise_for_status()
        event_id = r.json()["event_id"]

        stream = requests.get(f"{API_URL}/{event_id}", stream=True, timeout=300)
        if show_stream:
            cp(C.CYAN, "\n🤖 AI > ", end="")

        for line in stream.iter_lines():
            if not line:
                continue
            text = line.decode()
            if not text.startswith("data: "):
                continue
            try:
                data = json.loads(text[6:])
                if (isinstance(data, list) and data
                        and isinstance(data[0], list) and data[0]):
                    new_answer = data[0][0]
                    if len(new_answer) > len(answer):
                        diff = new_answer[len(answer):]
                        if show_stream:
                            print(diff, end="", flush=True)
                        answer = new_answer
            except Exception:
                pass

        if show_stream:
            print()
    except Exception as e:
        cp(C.RED, f"\n❌ API Error: {e}")
    return answer

# ══════════════════════════════════════════
#  JSON EXTRACTOR  (3 fallback strategies)
# ══════════════════════════════════════════
def extract_json(text: str):
    # 1. Direct
    try:
        return json.loads(text.strip())
    except Exception:
        pass
    # 2. Strip fences
    clean = re.sub(r"```(?:json)?", "", text).strip().rstrip("`").strip()
    try:
        return json.loads(clean)
    except Exception:
        pass
    # 3. Grab first {...} block
    m = re.search(r'\{[\s\S]*\}', text)
    if m:
        try:
            return json.loads(m.group())
        except Exception:
            pass
    return None

# ══════════════════════════════════════════
#  FILE HELPERS
# ══════════════════════════════════════════
def write_file(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")

def read_file(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")

def print_tree(root: Path, prefix=""):
    entries = sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name))
    for i, entry in enumerate(entries):
        connector = "└── " if i == len(entries) - 1 else "├── "
        icon = "📄" if entry.is_file() else "📁"
        cp(C.YELLOW, f"  {prefix}{connector}{icon} {entry.name}")
        if entry.is_dir():
            ext = "    " if i == len(entries) - 1 else "│   "
            print_tree(entry, prefix + ext)

# ══════════════════════════════════════════
#  SYSTEM PROMPT  (injected as user turn)
# ══════════════════════════════════════════
AGENT_SYSTEM = """\
You are an elite AI coding agent. When the user asks you to create or edit code/projects, \
you MUST respond with ONLY a raw JSON object (no markdown fences, no explanation before or after).

━━━ FORMAT FOR CREATING / GENERATING FILES ━━━
{
  "action": "create",
  "project_name": "folder-name",
  "description": "one-line description",
  "files": [
    {"path": "relative/path/file.ext", "content": "FULL file content"}
  ],
  "setup": "pip install ... / npm install ..."
}

━━━ FORMAT FOR EDITING AN EXISTING FILE ━━━
{
  "action": "edit",
  "file": "workspace/project/path/to/file.ext",
  "mode": "replace",
  "content": "NEW full file content"
}
OR for surgical patch:
{
  "action": "edit",
  "file": "workspace/project/path/to/file.ext",
  "mode": "patch",
  "old": "exact text to find",
  "new": "replacement text"
}

━━━ FORMAT FOR CREATING A SINGLE FILE OR FOLDER ━━━
{
  "action": "touch",
  "path": "workspace/folder/file.ext",
  "content": "file content or empty string"
}
{
  "action": "mkdir",
  "path": "workspace/my-new-folder"
}

RULES:
- Output ONLY the JSON — no intro sentence, no trailing text, no ```
- file content must be COMPLETE and working — no TODOs, no placeholders
- always include README.md in "create" projects
- paths in "create" action are relative to the project folder
- paths in "edit" / "touch" / "mkdir" are relative to the current working directory
"""

AGENT_ACK = (
    "Understood. I am a coding agent. "
    "I will reply with ONLY raw JSON for all file/project operations. Ready."
)

def build_agent_messages(history: list, user_prompt: str) -> list:
    """Prepend fake system-as-user-turn so HY3 API (no system role) gets the persona."""
    return [
        {"role": "user",      "content": AGENT_SYSTEM},
        {"role": "assistant", "content": AGENT_ACK},
        *history,
        {"role": "user",      "content": user_prompt},
    ]

# ══════════════════════════════════════════
#  EXECUTE AGENT ACTION
# ══════════════════════════════════════════
def execute(data: dict) -> str:
    action = data.get("action", "")

    # ── CREATE: multi-file project ──────────────────────────
    if action == "create":
        name   = re.sub(r'[^\w\-]', '_', data.get("project_name", f"proj_{_ts()}"))
        folder = WORK_DIR / name
        folder.mkdir(parents=True, exist_ok=True)

        created = []
        for f in data.get("files", []):
            rel  = f.get("path", "").lstrip("/")
            body = f.get("content", "")
            if not rel:
                continue
            write_file(folder / rel, body)
            created.append(rel)

        cp(C.GREEN,   f"\n✅ Project created: {folder}/")
        cp(C.CYAN,    f"📝 {data.get('description', '')}")
        cp(C.YELLOW,  f"📦 {len(created)} file(s):")
        print_tree(folder)

        setup = data.get("setup", "")
        if setup:
            cp(C.CYAN, f"\n⚡ Setup: {C.YELLOW}{setup}")

        return str(folder)

    # ── EDIT: replace or patch ───────────────────────────────
    if action == "edit":
        path = Path(data.get("file", ""))
        if not path.exists():
            cp(C.RED, f"❌ File not found: {path}")
            return ""

        mode = data.get("mode", "replace")
        if mode == "replace":
            write_file(path, data.get("content", ""))
            cp(C.GREEN, f"✏️  Replaced: {path}")
        elif mode == "patch":
            old_text = data.get("old", "")
            new_text = data.get("new", "")
            current  = read_file(path)
            if old_text not in current:
                cp(C.RED, f"❌ Patch target not found in {path}")
                return ""
            write_file(path, current.replace(old_text, new_text, 1))
            cp(C.GREEN, f"🔧 Patched: {path}")
        return str(path)

    # ── TOUCH: create single file ────────────────────────────
    if action == "touch":
        path = Path(data.get("path", ""))
        write_file(path, data.get("content", ""))
        cp(C.GREEN, f"📄 Created file: {path}")
        return str(path)

    # ── MKDIR: create folder ─────────────────────────────────
    if action == "mkdir":
        path = Path(data.get("path", ""))
        path.mkdir(parents=True, exist_ok=True)
        cp(C.GREEN, f"📁 Created folder: {path}")
        return str(path)

    cp(C.RED, f"❓ Unknown action: {action}")
    return ""

def _ts():
    return datetime.now().strftime("%Y%m%d_%H%M%S")

# ══════════════════════════════════════════
#  NATURAL LANGUAGE → AGENT PROMPT
# ══════════════════════════════════════════
# Keywords that should trigger agent (not plain chat)
AGENT_TRIGGERS = [
    r"\bcreate\b", r"\bgenerate\b", r"\bmake\b", r"\bbuild\b",
    r"\bwrite\b",  r"\badd\b",      r"\bedit\b", r"\bupdate\b",
    r"\bchange\b", r"\bfix\b",      r"\brefactor\b", r"\bmodify\b",
    r"\bfolder\b", r"\bdirectory\b",r"\bfile\b",  r"\bproject\b",
    r"\bapp\b",    r"\bapi\b",      r"\bscript\b",
]

def is_agent_request(text: str) -> bool:
    low = text.lower()
    return any(re.search(p, low) for p in AGENT_TRIGGERS)

# ══════════════════════════════════════════
#  CONTEXT: show files in workspace
# ══════════════════════════════════════════
def workspace_context() -> str:
    if not WORK_DIR.exists() or not any(WORK_DIR.iterdir()):
        return "(workspace is empty)"
    lines = []
    for p in sorted(WORK_DIR.rglob("*")):
        if p.is_file():
            lines.append(str(p))
    return "\n".join(lines[:60])   # cap at 60 lines

# ══════════════════════════════════════════
#  COMMANDS
# ══════════════════════════════════════════
def cmd_ls():
    if not WORK_DIR.exists() or not any(WORK_DIR.iterdir()):
        cp(C.DIM, "  (workspace is empty)")
        return
    cp(C.CYAN, f"\n📁 workspace/")
    print_tree(WORK_DIR)

def cmd_show(args: str):
    path = Path(args.strip())
    if not path.exists():
        path = WORK_DIR / args.strip()
    if not path.exists():
        cp(C.RED, f"❌ Not found: {args}")
        return
    cp(C.CYAN, f"\n── {path} ──")
    cp(C.WHITE, path.read_text(encoding="utf-8"))

def cmd_rm(args: str):
    path = Path(args.strip())
    if not path.exists():
        path = WORK_DIR / args.strip()
    if path.is_dir():
        shutil.rmtree(path)
        cp(C.YELLOW, f"🗑  Deleted folder: {path}")
    elif path.is_file():
        path.unlink()
        cp(C.YELLOW, f"🗑  Deleted file: {path}")
    else:
        cp(C.RED, f"❌ Not found: {args}")

def cmd_save(history: list):
    with open(SAVE_FILE, "w", encoding="utf-8") as f:
        for m in history:
            f.write(f"{m['role'].upper()}: {m['content']}\n\n")
    cp(C.GREEN, f"💾 Chat saved to {SAVE_FILE}")

def show_help():
    print(f"""
{C.CYAN}{C.BOLD}╔══════════════════════════════════════════════════╗
║  🤖  HY3 AI CODING AGENT                        ║
║  Just talk naturally — agent auto-detects intent ║
╚══════════════════════════════════════════════════╝{C.RESET}

{C.GREEN}Natural Language (auto agent){C.RESET}
  create a Flask REST API with JWT auth
  build a React todo app with dark mode
  edit workspace/myapp/main.py — add logging
  make a folder called experiments
  create a file utils.py with helper functions

{C.YELLOW}Slash Commands{C.RESET}
  /ls              → list workspace files
  /show <path>     → print file contents
  /rm <path>       → delete file or folder
  /clear           → clear screen
  /reset           → new conversation
  /save            → save chat to {SAVE_FILE}
  /help            → this menu
  exit             → quit
""")

# ══════════════════════════════════════════
#  MAIN LOOP
# ══════════════════════════════════════════
def main():
    WORK_DIR.mkdir(exist_ok=True)
    clear()
    show_help()

    history: list = []

    while True:
        try:
            raw = input(f"\n{C.BOLD}{C.GREEN}You > {C.RESET}").strip()
        except (KeyboardInterrupt, EOFError):
            cp(C.YELLOW, "\n\nGoodbye! 👋")
            break

        if not raw:
            continue

        low = raw.lower()

        # ── Built-in commands ──────────────────────────────
        if low == "exit":
            cp(C.YELLOW, "Goodbye! 👋"); break

        if low in ("/help", "help"):
            show_help(); continue

        if low == "/clear":
            clear(); continue

        if low == "/reset":
            history.clear()
            cp(C.YELLOW, "🔄 Conversation reset."); continue

        if low == "/ls":
            cmd_ls(); continue

        if low.startswith("/show "):
            cmd_show(raw[6:]); continue

        if low.startswith("/rm "):
            cmd_rm(raw[4:]); continue

        if low == "/save":
            cmd_save(history); continue

        # ── Decide: agent vs plain chat ───────────────────
        if is_agent_request(raw):
            cp(C.MAGENTA, "\n🚀 Agent mode — generating...")

            # Give agent awareness of existing files
            ctx = workspace_context()
            full_prompt = (
                f"Current workspace files:\n{ctx}\n\n"
                f"User request: {raw}\n\n"
                "Respond with ONLY the JSON object."
            )

            msgs = build_agent_messages(history, full_prompt)

            # Silent call (no stream so we can parse JSON cleanly)
            raw_resp = hy3_chat(full_prompt, [
                {"role": "user",      "content": AGENT_SYSTEM},
                {"role": "assistant", "content": AGENT_ACK},
                *history,
            ], show_stream=False)

            # Stream-print the raw response for transparency
            cp(C.DIM, "\n── raw model output ──")
            print(raw_resp[:600] + ("…" if len(raw_resp) > 600 else ""))
            cp(C.DIM, "──────────────────────")

            data = extract_json(raw_resp)
            if data:
                execute(data)
            else:
                cp(C.RED, "⚠️  Could not parse JSON. Showing raw reply:")
                cp(C.WHITE, raw_resp)
                # Save raw for debugging
                Path("agent_debug.txt").write_text(raw_resp, encoding="utf-8")

            history.append({"role": "user",      "content": raw})
            history.append({"role": "assistant",  "content": raw_resp})

        else:
            # ── Plain conversation ─────────────────────────
            history.append({"role": "user", "content": raw})
            answer = hy3_chat(raw, history[:-1], show_stream=True)
            if answer:
                history.append({"role": "assistant", "content": answer})

if __name__ == "__main__":
    main()