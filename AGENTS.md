# Calendar Central

This is a new project based on Daymark, the task and calendar app in the sibling `ticktick_opensource` repository. The `context/` links provide reference material from both its main checkout and the development worktree used for the latest calendar changes.

## Reference links

| Link | What to expect |
| --- | --- |
| `context/daymark/` | Main Daymark checkout: application source, native platform adapters, sync server, tests and build tools. |
| `context/daymark-worktree/` | Development checkout at `/Users/mararn1618/.codex/worktrees/daymark-open-access/ticktick_opensource`. Contains source, worktree-local documentation and test evidence. Its branch at setup is `codex/calendar-drag-swipe`. |
| `context/daymark-spec/` | `functional-spec.md` describes capabilities, workflows and planned scope. `acceptance-tests.md` lists expected behavior. |
| `context/daymark-docs/` | `design/` contains architecture and storage/sync decisions; `implementation/` records delivered changes and verification limits; `research/` contains TickTick findings; `plan/` contains the roadmap. |
| `context/daymark-prototypes/` | Earlier UI experiments and review demos. These may differ from the shipped app. |

## Start here

1. Read `context/daymark-spec/functional-spec.md`.
2. Read `context/daymark-docs/design/architecture.md` and `context/daymark-docs/design/universal-runtime.md`.
3. Check `context/daymark-worktree/` as well as the main checkout. Compare their Git status and commits, and inspect relevant worktree-local documentation and evidence. Do not assume all worktree changes or local files are present in main. The other documentation and prototype links point to main.
4. Inspect the relevant implementation and tests in both checkouts:
    - `src/core/`: task model and domain operations.
    - `src/ui/`: shared interface and calendar interactions.
    - `src/integrations/`, `src/runtime/`, `src/adapters/`: integrations and runtime boundaries.
    - `desktop/`, `android/`, `ios/`: platform-specific code.
    - `sync-server/`: hosted sync and shared services.
    - `tests/`: behavioral checks and isolated UI fixtures.

## Working rules

- Write Calendar Central's implementation outside `context/`.
- Treat the linked project as a reference. Editing through a symlink changes the original Daymark files.
- The links follow their respective checkouts as they change; they are not frozen snapshots. Main and the development worktree can diverge. Record the source path and commit when reusing code.
- Some documentation is historical or describes planned features. Check current code and implementation evidence before assuming a feature is complete.
- Use synthetic data and isolated storage when running reference code. Keep Daymark's real workspace, credentials and provider connections separate.
- Preserve the original MIT license and notices when copying Daymark code.
