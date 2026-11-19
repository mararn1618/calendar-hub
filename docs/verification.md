# First Mac build verification

On 19 November 2026, Calendar Central 0.1.0 ran on Apple Silicon with macOS 27.0.1 and the Europe/Berlin time zone. macOS LaunchServices opened the locally signed app with its saved connections. All 43 unit tests passed. [Launch result](../build/verification/launch-services.json)

All seven [user journeys](user-journeys.md) passed in the packaged app. The run used pointer and keyboard input and fresh profiles. Independent local HTTP services exercised the TickTick and Google adapters, including browser consent and PKCE. A simulated Mac calendar store exercised the Google account picker and edits through the native bridge. The report records the app archive’s SHA-256 fingerprint. [Packaged run](../build/verification/desktop-2026-11-19T10-24-44-182Z/report.json)

| Journey | Evidence from the packaged app |
| --- | --- |
| Connect sources | TickTick and Google connected through browser consent. Reconnecting TickTick with a new grant preserved the selected list. The original task appeared once. The Google copy calendar stayed off. Credentials were encrypted on disk. [Combined day](../build/verification/desktop-2026-11-19T10-24-44-182Z/day-with-three-sources.png) |
| Navigate | Monday-to-Sunday Week, a rolling 14-day view, horizontal date scrolling and vertical hour scrolling passed. [Week](../build/verification/desktop-2026-11-19T10-24-44-182Z/full-week.png) · [Rolling view](../build/verification/desktop-2026-11-19T10-24-44-182Z/rolling-view-scrolled.png) |
| Plan a task | Dragging, resizing, moving to tomorrow and completing changed the same TickTick ID. Notes, checklist, tags and priority survived. [Scheduled task](../build/verification/desktop-2026-11-19T10-24-44-182Z/ticktick-task-planned.png) |
| Create both kinds | A task in the chosen list and an appointment on the chosen calendar each appeared exactly once and survived restart. [Packaged run](../build/verification/desktop-2026-11-19T10-24-44-182Z/report.json) |
| Edit an event | Move and resize preserved the event description. Guest updates and a single recurring occurrence required review. A changed provider version caused a conflict. [Guest review](../build/verification/desktop-2026-11-19T10-24-44-182Z/google-guest-review.png) · [Conflict](../build/verification/desktop-2026-11-19T10-24-44-182Z/google-stale-edit.png) |
| Hide, restore or delete | A locally hidden read-only meeting stayed at the source and remained hidden across restart. Restore brought it back. A separate confirmation deleted an eligible Google event. [Hidden after restart](../build/verification/desktop-2026-11-19T10-24-44-182Z/bmw-hidden-after-restart.png) · [Delete review](../build/verification/desktop-2026-11-19T10-24-44-182Z/google-delete-review.png) |
| Recover | A failed feed retained its cache while another feed refreshed. A TickTick create with no returned ID stayed under review after restart and blocked a duplicate send. [Stale source](../build/verification/desktop-2026-11-19T10-24-44-182Z/bmw-stale-cache.png) · [Unconfirmed create](../build/verification/desktop-2026-11-19T10-24-44-182Z/ticktick-unconfirmed-create.png) |

The Apple Calendar picker started with every candidate unchecked. The selected Google calendar allowed edits after restart. A second CalDAV account was excluded, and the generic Mac work calendar stayed read-only. The native tests also compiled Swift and checked dates, access rules and preservation of event details on an unsaved EventKit event. [Google account picker](../build/verification/desktop-2026-11-19T10-24-44-182Z/mac-google-calendar-picker.png) · [Selection after restart](../build/verification/desktop-2026-11-19T10-24-44-182Z/mac-google-selection-after-restart.png)

## Live accounts

The live run used a new TickTick list and Google calendar, both named **Calendar Central Test 38cfe340**. Both passed on the same packaged build as the isolated tests. [Combined live result](../build/verification/live/cd014f57-6168-42a7-98ff-b8eeb3839ef3-verified.json)

- **TickTick** registered Calendar Central automatically, completed browser sign-in and returned the account’s lists. The app created a disposable task, moved it, resized it and completed it. Independent reads of the same task ID confirmed completion and preserved notes and checklist. [Sign-in result](../build/verification/ticktick-signin.json) · [Source checks](../build/verification/live/cd014f57-6168-42a7-98ff-b8eeb3839ef3-cloud.json)
- **Google** connected through the account in macOS Internet Accounts. The app created an appointment and changed its times. Hiding and restoring preserved the original. The Google Calendar API returned the same event at 13:00 to 14:00 and after a move to 14:30 to 15:30 on 20 November. After deletion in the app, Google returned that event as cancelled. Its ID matched the original EventKit event. [Google cloud checks](../build/verification/live/cd014f57-6168-42a7-98ff-b8eeb3839ef3-cloud.json)
- **BMW Exchange** was unavailable on this Mac. A disposable Google calendar marked read-only exercised the work-calendar fallback, including an external move, refresh and restart. [Packaged live steps](../build/verification/live/cd014f57-6168-42a7-98ff-b8eeb3839ef3.json)

The test destinations are available for another run. The TickTick task is complete, and the Google appointment is deleted.
