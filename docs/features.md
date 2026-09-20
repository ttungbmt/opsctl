# Ops CLI – Planned Features

## 1. Core CLI Platform

- Command / subcommand architecture với oclif
- Global flags:
  - `--json`
  - `--quiet`
  - `--verbose`
  - `--debug`
  - `--yes`
  - `--dry-run`
  - `--non-interactive`
- Unified error handling
- Structured logging
- Config management
- Environment detection
- OS / architecture detection
- Shell detection
- Command execution abstraction
- Process lifecycle management
- Exit-code normalization
- Human-readable output
- Machine-readable JSON output
- Shell completion
- Command aliases
- Command suggestions
- Built-in help
- Version management
- Self-update
- Release channels:
  - stable
  - beta
  - dev
- Telemetry opt-in/out
- Diagnostic information

---

## 2. Bootstrap New Machine

Mục tiêu:

> Một command có thể biến máy mới thành môi trường làm việc sẵn sàng.

Commands dự kiến:

```bash
ops bootstrap
ops bootstrap workstation
ops bootstrap server
ops bootstrap developer
```

Features:

- Detect operating system
- Detect existing tools
- Install missing dependencies
- Setup package managers
- Setup development environment
- Setup shell
- Setup Git
- Setup SSH
- Setup dotfiles
- Setup terminal tools
- Setup editor
- Setup runtime managers
- Setup Docker
- Setup cloud CLIs
- Apply personal profiles
- Verify installation
- Generate final bootstrap report

Profiles:

```text
minimal
developer
workstation
server
cloud
personal
full
```

---

## 3. Software / Tool Management

Một mặt tiền duy nhất — `ops tool` — cho mọi provider bên dưới:

```text
winget
brew
apt
dnf
pacman
scoop
choco
npm
pnpm
pip
uv
cargo
mise
```

Mục tiêu:

```bash
ops tool install docker
```

thay vì user phải biết:

```text
Windows → winget
macOS   → brew
Ubuntu  → apt
```

Ép provider khi cần:

```bash
ops tool install apt:git
ops tool install brew:jq
```

> *Package* (một entry của OS package manager) và *tool* (khái niệm cấp cao
> nằm trên nó) là hai **tầng trong code**, không phải hai nhóm lệnh. Không có
> `ops package`.

---

## 4. Tool Lifecycle

Vòng đời đầy đủ của một tool — cao hơn hẳn "cài một gói".

```bash
ops tool install
ops tool setup
ops tool update
ops tool status
ops tool doctor
ops tool remove
```

Ví dụ:

```bash
ops tool install node
ops tool install terraform
ops tool setup git
ops tool setup docker
```

Tool providers ban đầu:

```text
git
mise
node
python
go
rust
bun
pnpm
docker
terraform
kubectl
helm
gh
jq
fzf
ripgrep
yt-dlp
ffmpeg
chezmoi
```

---

## 5. Tool Configuration

Không chỉ cài tool mà còn cấu hình theo convention của bạn.

Ví dụ:

```bash
ops setup git
ops setup ssh
ops setup zsh
ops setup docker
ops setup mise
```

Có thể quản lý:

- config files
- environment variables
- PATH
- aliases
- shell integrations
- credentials references
- plugins/extensions
- default behaviors

---

## 6. Dotfiles & Environment

Integration với:

```text
chezmoi
mise
shell
Git
SSH
```

Commands:

```bash
ops env status
ops env sync
ops env doctor

ops dotfiles init
ops dotfiles apply
ops dotfiles diff
ops dotfiles update
```

Mục tiêu:

> Máy mới → bootstrap → môi trường gần giống máy cũ.

---

## 7. System Management

```bash
ops system info
ops system doctor
ops system update
ops system cleanup
ops system status
ops system env
ops system path
```

Features:

- OS information
- CPU / RAM / disk
- PATH diagnostics
- environment diagnostics
- package manager status
- network checks
- dependency checks
- filesystem checks
- permission checks
- common problem detection

---

## 8. Service Management

Unified abstraction cho:

```text
systemd
Windows Services
launchd
Docker services
```

Commands:

```bash
ops service list
ops service status
ops service start
ops service stop
ops service restart
ops service enable
ops service disable
```

---

## 9. Process / Command Runner

Một execution layer dùng chung toàn project.

Features:

- execute commands
- stream stdout/stderr
- capture output
- retries
- timeout
- cancellation
- elevated execution
- environment overrides
- working directory
- concurrent commands
- command history
- dry-run mode

---

## 10. CLI Wrappers

Một trong những feature quan trọng nhất.

Mục tiêu:

> Wrap những CLI mạnh nhưng có quá nhiều flags thành interface đơn giản, opinionated và dễ nhớ.

Providers dự kiến:

```text
yt-dlp
ffmpeg
docker
git
gh
terraform
kubectl
helm
cloudflare
aws
oci
gcloud
rclone
restic
```

---

## 11. YouTube / Media

Feature đầu tiên rất phù hợp để thử wrapper architecture.

```bash
ops youtube download URL
ops youtube audio URL
ops youtube video URL
ops youtube playlist URL
ops youtube subtitles URL
ops youtube metadata URL
ops youtube archive URL
```

Bên dưới có thể orchestrate:

```text
yt-dlp
+
ffmpeg
+
filesystem
+
metadata
```

Preset:

```text
best
1080p
720p
audio
podcast
archive
mobile
```

Ví dụ:

```bash
ops youtube audio URL
```

thay vì phải nhớ hàng loạt:

```text
--extract-audio
--audio-format
--embed-thumbnail
--embed-metadata
--write-info-json
...
```

---

## 12. Docker

```bash
ops docker status
ops docker ps
ops docker logs
ops docker cleanup
ops docker prune
ops docker restart
ops docker compose
```

Higher-level workflows:

```bash
ops docker cleanup --safe
ops docker doctor
```

---

## 13. Git & GitHub

Git:

```bash
ops git setup
ops git status
ops git cleanup
ops git sync
ops git branches
```

GitHub:

```bash
ops github auth
ops github repo
ops github clone
ops github issue
ops github pr
ops github release
```

Wrap:

```text
git
gh
```

---

## 14. SSH & Remote Machines

```bash
ops ssh list
ops ssh connect
ops ssh setup
ops ssh test
ops ssh copy
```

Server inventory:

```text
oracle
aws
homelab
work
personal
```

Possible future commands:

```bash
ops server status
ops server doctor
ops server update
ops server exec
```

---

## 15. Cloud

Unified interface cho:

```text
AWS
Oracle Cloud
Cloudflare
Google Cloud
Azure
```

Structure:

```bash
ops cloud aws ...
ops cloud oracle ...
ops cloud cloudflare ...
```

Features:

- authentication
- account information
- resource listing
- deployments
- DNS
- storage
- compute
- secrets references
- common workflows

Không nhằm thay thế toàn bộ native cloud CLI.

Mục tiêu là:

> Wrap những workflow bạn dùng thường xuyên.

---

## 16. Workflow Engine

Cho phép compose nhiều tools thành một workflow.

Ví dụ:

```bash
ops workflow new-machine
ops workflow backup
ops workflow youtube-archive
ops workflow deploy
ops workflow cleanup
```

Một workflow có thể:

```text
detect
→ install
→ configure
→ execute
→ verify
→ report
```

Có thể hỗ trợ:

```text
dependencies
steps
conditions
retries
parallel execution
rollback
```

---

## 17. Profiles

Profiles định nghĩa desired environment.

```bash
ops profile list
ops profile show
ops profile apply developer
```

Ví dụ:

```yaml
developer:
  packages:
    - git
    - docker
    - jq

  tools:
    - node
    - go
    - python

  setup:
    - git
    - ssh
    - mise
```

Profiles dự kiến:

```text
minimal
personal
developer
work
server
cloud
ai
full
```

---

## 18. Plan / Apply

Tiến tới desired-state automation.

```bash
ops plan
ops apply
```

Ví dụ:

```text
✓ Git               installed
+ Docker            install
↑ Node 22 → 24
~ ~/.gitconfig      update
✓ SSH               configured
```

Flow:

```text
Detect
→ Compare
→ Plan
→ Apply
→ Verify
```

Yêu cầu quan trọng:

> Operations phải idempotent khi có thể.

---

## 19. Doctor

Một feature trung tâm.

```bash
ops doctor
ops doctor system
ops doctor docker
ops doctor dev
ops doctor cloud
```

Output:

```text
✓ Git
✓ Docker
✓ SSH
! Node outdated
✗ Terraform missing
```

Có thể hỗ trợ:

```bash
ops doctor --fix
```

---

## 20. TUI

Chạy:

```bash
ops
```

mở Ink TUI.

Các screen dự kiến:

```text
Dashboard
System
Software
Tools
Development
Docker
Servers
Cloud
Workflows
Plugins
Logs
Settings
```

Dashboard ví dụ:

```text
┌ Ops ─────────────────────────────────────┐
│                                          │
│ System        Tools         Services     │
│ ✓ Windows     ✓ Git         ✓ Docker     │
│ ✓ WSL         ✓ mise        ✓ SSH        │
│ ✓ Network     ! Node        ✗ Redis      │
│                                          │
├──────────────────────────────────────────┤
│ Servers                                  │
│ ✓ Oracle                                 │
│ ✓ AWS                                    │
│                                          │
├──────────────────────────────────────────┤
│ Recent Actions                           │
│ • Docker cleanup                         │
│ • Node upgraded                          │
│ • Dotfiles synced                        │
└──────────────────────────────────────────┘
```

Stack:

```text
React
+
Ink
```

---

## 21. Plugin Platform

Sử dụng sức mạnh của oclif.

```bash
ops plugins list
ops plugins install
ops plugins update
ops plugins remove
```

Architecture:

```text
ops
├── core
├── plugin-system
├── plugin-cloud
├── plugin-youtube
├── plugin-ai
└── third-party plugins
```

Có thể hỗ trợ:

- core plugins
- user plugins
- local plugins
- JIT plugins
- hooks
- plugin metadata
- compatibility checking

---

## 22. Integration Layer

Adapters/providers cho các công cụ bên ngoài.

Ví dụ:

```text
providers/
├── winget
├── apt
├── brew
├── mise
├── chezmoi
├── docker
├── git
├── gh
├── ytdlp
├── ffmpeg
├── terraform
├── kubectl
├── aws
├── oci
└── cloudflare
```

Nguyên tắc:

```text
Feature != Provider
```

Ví dụ:

```text
youtube audio
```

là feature.

```text
yt-dlp + ffmpeg
```

là implementation/provider.

---

## 23. Configuration

Global config:

```bash
ops config get
ops config set
ops config edit
ops config path
ops config reset
```

Possible config:

```yaml
profile: developer

defaults:
  packageManager: auto
  editor: nvim

youtube:
  quality: 1080p
  subtitles:
    - vi
    - en
```

Config hierarchy:

```text
defaults
↓
global config
↓
profile
↓
project config
↓
environment variables
↓
CLI flags
```

---

## 24. Secrets

CLI không tự lưu secrets plaintext.

Integration dự kiến:

```text
1Password
Bitwarden
Infisical
SOPS
system keychain
environment variables
cloud secret managers
```

Commands có thể:

```bash
ops secret get
ops secret inject
ops secret doctor
```

---

## 25. Project Automation

Sau này CLI có thể hỗ trợ project-level workflows:

```bash
ops project init
ops project setup
ops project doctor
ops project dev
ops project build
ops project clean
```

Có thể detect:

```text
Node
Python
Go
Rust
Docker
Terraform
```

và tự chọn workflow phù hợp.

---

## 26. Task Runner

Có thể wrap hoặc integrate:

```text
mise tasks
just
npm scripts
Makefile
Taskfile
```

Commands:

```bash
ops task list
ops task run
```

Mục tiêu là tạo một unified task interface.

---

## 27. Search / Discovery

Khi command nhiều:

```bash
ops search docker
ops search youtube
```

TUI có command palette:

```text
> Install Docker
  Docker Cleanup
  Docker Doctor
  Docker Logs
```

Có thể fuzzy search command/tool/workflow.

---

## 28. History & Audit

Theo dõi:

```text
commands
changes
installations
upgrades
workflow executions
```

Commands:

```bash
ops history
ops history show
```

Sau này hỗ trợ rollback ở những operation thích hợp.

---

## 29. Backup & Restore

```bash
ops backup
ops restore
```

Có thể backup:

```text
configs
dotfiles
tool lists
package lists
profiles
CLI settings
```

Một use case lớn:

```text
old machine
    ↓
ops backup

new machine
    ↓
ops bootstrap
ops restore
```

---

## 30. AI / Agent

Đây là phase sau.

```bash
ops ai ask
ops ai diagnose
ops ai fix
ops ai explain
ops agent run
```

Ví dụ:

```bash
ops ai diagnose docker
```

AI có thể:

```text
read diagnostic state
→ inspect logs
→ propose plan
→ ask approval
→ invoke ops commands
→ verify result
```

AI không tự thao tác trực tiếp OS nếu có thể.

Thay vào đó:

```text
AI
 ↓
Ops command/API
 ↓
providers
 ↓
system
```

---

## 31. Agent-Friendly CLI

Mọi feature quan trọng cần hỗ trợ non-interactive mode.

Ví dụ:

```bash
ops tool install docker \
  --yes \
  --json \
  --non-interactive
```

Principles:

```text
Interactive for humans
Structured output for machines
Deterministic commands for agents
```

Điều này cho phép sử dụng với:

```text
Claude Code
Codex CLI
Gemini CLI
n8n
GitHub Actions
scripts
other agents
```

---

## 32. MCP / Agent Integration

Future:

```bash
ops mcp serve
```

Expose capabilities như:

```text
install_tool
check_system
download_youtube
manage_docker
list_servers
run_workflow
```

để AI agents có thể sử dụng Ops CLI như một tool layer.

---

## 33. Logs & Observability

```bash
ops logs
ops logs tail
```

Features:

- structured logs
- verbose/debug mode
- execution timings
- command tracing
- workflow tracing
- plugin diagnostics

---

## 34. Security

Đặc biệt quan trọng vì CLI có quyền hệ thống.

Features:

- privilege escalation boundaries
- command allowlisting
- confirmation cho destructive actions
- dry-run
- safe defaults
- secret redaction
- plugin trust levels
- checksum/signature verification
- audit history

---

## 35. Self Management

```bash
ops version
ops update
ops uninstall
ops doctor self
```

Plugin:

```bash
ops plugins update
```

Configuration migrations khi version thay đổi.

---

# Suggested Product Evolution

```text
Phase 1
Core CLI
+ command runner
+ config
+ doctor
+ basic package/tool management

        ↓

Phase 2
Bootstrap
+ profiles
+ setup tools
+ winget/apt/brew/mise/chezmoi

        ↓

Phase 3
CLI wrappers
+ yt-dlp
+ ffmpeg
+ Docker
+ Git/GitHub

        ↓

Phase 4
Workflow engine
+ plan/apply
+ idempotency
+ history

        ↓

Phase 5
Ink TUI
+ dashboard
+ command palette
+ system/tool/workflow management

        ↓

Phase 6
oclif plugin platform
+ core plugins
+ user plugins
+ JIT plugins

        ↓

Phase 7
Cloud + remote servers
+ SSH
+ AWS
+ OCI
+ Cloudflare

        ↓

Phase 8
AI / Agent
+ AI diagnosis
+ MCP
+ agent tool API
+ natural-language workflows
```

# Product Definition

**Ops CLI** is an opinionated command platform for bootstrapping machines, managing tools, simplifying complex CLIs, composing automation workflows, and eventually providing a unified TUI and agent interface for personal operations.

Core idea:

> **One command layer for your machines, tools, and workflows.**

Long-term direction:

```text
Bootstrap CLI
      ↓
Tool Manager
      ↓
CLI Orchestrator
      ↓
Workflow Engine
      ↓
TUI Control Center
      ↓
Plugin Platform
      ↓
AI-powered Personal Ops
```