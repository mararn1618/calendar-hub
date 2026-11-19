# First Mac build verification

On 19 November 2026, Calendar Central 0.1.0 ran on Apple Silicon with macOS 27.0.1 and the Europe/Berlin time zone. macOS LaunchServices opened the locally signed app and its renderer initialized an empty profile. [Launch result](../build/verification/launch-services.json)

All seven [user journeys](user-journeys.md) passed in the packaged app. The run used pointer and keyboard input, a fresh persistent profile and independent local HTTP services. The production adapters performed their normal requests. The OAuth consent page and provider accounts used synthetic data. The report includes the tested app archive's SHA-256 fingerprint. [Packaged run](../build/verification/desktop-2026-11-19T09-43-12-277Z/report.json)

| Journey | Evidence from the packaged app |
| --- | --- |
| Connect sources | TickTick and Google connected through the settings screen. The original task appeared once. The Google copy calendar stayed off. Credentials were encrypted on disk. [Combined day](../build/verification/desktop-2026-11-19T09-43-12-277Z/day-with-three-sources.png) |
| Navigate | Monday-to-Sunday Week, a rolling 14-day view, horizontal date scrolling and vertical hour scrolling passed. [Week](../build/verification/desktop-2026-11-19T09-43-12-277Z/full-week.png) · [Rolling view](../build/verification/desktop-2026-11-19T09-43-12-277Z/rolling-view-scrolled.png) |
| Plan a task | Dragging, resizing, moving to tomorrow and completing changed the same TickTick ID. Notes, checklist, tags and priority survived. [Scheduled task](../build/verification/desktop-2026-11-19T09-43-12-277Z/ticktick-task-planned.png) |
| Create both kinds | A task in the chosen list and an appointment on the chosen calendar each appeared exactly once and survived restart. [Packaged run](../build/verification/desktop-2026-11-19T09-43-12-277Z/report.json) |
| Edit an event | Move and resize preserved the event description. Guest updates and a single recurring occurrence required review. A changed provider version caused a conflict. [Guest review](../build/verification/desktop-2026-11-19T09-43-12-277Z/google-guest-review.png) · [Conflict](../build/verification/desktop-2026-11-19T09-43-12-277Z/google-stale-edit.png) |
| Hide, restore or delete | A locally hidden read-only meeting stayed at the source and remained hidden across restart. Restore brought it back. A separate confirmation deleted an eligible Google event. [Hidden after restart](../build/verification/desktop-2026-11-19T09-43-12-277Z/bmw-hidden-after-restart.png) · [Delete review](../build/verification/desktop-2026-11-19T09-43-12-277Z/google-delete-review.png) |
| Recover | A failed feed retained its cache while another feed refreshed. A TickTick create with no returned ID stayed under review after restart and blocked a duplicate send. [Stale source](../build/verification/desktop-2026-11-19T09-43-12-277Z/bmw-stale-cache.png) · [Unconfirmed create](../build/verification/desktop-2026-11-19T09-43-12-277Z/ticktick-unconfirmed-create.png) |

## Live accounts

The live runner uses Calendar Central's own credentials and disposable items. It records progress and first-party verification separately. BMW Exchange is unavailable on this Mac. The work-calendar checks use a read-only Google source. [Live run status](../build/verification/live/latest.json)
