# Mac build verification

## First release

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

## TickTick account calendars

Version 0.2.0 passed all eight user journeys on Apple Silicon with macOS 27.0.1. The packaged test used fresh profiles and synthetic providers. It verified one account calendar, native folder and list order, searching collapsed folders, remembered filters, custom calendars, and creating a task in its original list. Moving a list or renaming and reordering a folder at the provider updated the picker. [Packaged run](../build/verification/desktop-2026-11-19T10-51-17-121Z/report.json) · [Folder picker](../build/verification/desktop-2026-11-19T10-51-17-121Z/ticktick-list-folders.png) · [Custom calendars](../build/verification/desktop-2026-11-19T10-51-17-121Z/ticktick-custom-calendars.png)

All 57 unit tests passed. A 54-list fixture checked that switching a recently loaded calendar off and on makes no provider requests. An explicit refresh still checks every visible list. Migration checks covered earlier list selections and local restrictions.

The installed app showed one TickTick calendar after upgrading. Its 54 task lists and seven folders matched the native account order, with Inbox shown separately. The previous seven selected lists and one selected Google calendar were preserved. The live check expanded a folder and cancelled the picker. [Live account check](../build/verification/ticktick-folder-order.json)

## Calendar notifications

Version 0.3.0 passed all nine user journeys and 70 unit tests on this Mac. The packaged run exercised the sidebar bell, preset and custom lead times, a denied permission request, restart, folder calendars, completed tasks, a rescheduled event and independent muting. A simulated notification center recorded the title and firing time of each reminder. The Google and TickTick services retained their original alarm settings. Google via Apple Calendar and a read-only Mac calendar each scheduled a timed reminder through the Mac calendar adapter. [Packaged run](../build/verification/desktop-2026-11-19T11-09-23-934Z/report.json) · [Bell menu](../build/verification/desktop-2026-11-19T11-09-23-934Z/calendar-bell-timing.png) · [Custom lead time](../build/verification/desktop-2026-11-19T11-09-23-934Z/calendar-notification-settings.png)

The signed app loaded the native notification bridge and read its permission status from macOS. The native tests exercised a one-time Apple notification trigger, cancellation and timezone handling. [Native permission check](../build/verification/native-notification-status.json)

## App icon and delivery after quit

Version 0.3.1 passed all nine app journeys and 70 unit tests. Finder returned the new icon for the signed bundle. The 1024-pixel entry matched the source artwork pixel for pixel, and the sidebar displayed the same design. [Finder icon](../build/verification/finder-icon-128.png) · [Packaged app](../build/verification/desktop-2026-11-19T11-42-34-078Z/day-with-three-sources.png)

On 19 November 2026 the Mac queued one local test notification. The app quit at 12:43:18 CET. At the scheduled time of 12:43:54 CET the system had no Calendar Central process running. A fresh launch confirmed the test identifier in the macOS list of delivered notifications. The test used an isolated profile and made no provider writes. [Delivery record](../build/verification/native-notification-delivery.json)

## Calendar Hub 0.4.0

The signed app identifies itself as Calendar Hub in Finder, the application menu and its window. macOS reported that notifications were allowed after the rename. The upgrade test opened an earlier Mac profile and recovered its encrypted Google and TickTick grants, saved view, filters and reminder settings. [Native name and permission check](../build/verification/calendar-hub-native.json)

All 76 automated tests and ten packaged app journeys passed. Drawing from 08:12 to 09:04 produced a draft from 08:15 to 09:00. Saving it sent exactly one create to the selected Google calendar. Reverse drags, midnight, a three-day all-day range, Escape and dropping outside the grid also passed. The packaged journeys used isolated calendars. [Packaged run](../build/verification/desktop-2026-11-19T11-57-24-007Z/report.json) · [Timed preview](../build/verification/desktop-2026-11-19T11-57-24-007Z/drag-create-timed-preview.png) · [Appointment editor](../build/verification/desktop-2026-11-19T11-57-24-007Z/drag-create-appointment.png)
