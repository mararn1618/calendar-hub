# Calendar Central first-release validation

Each journey starts in the Mac app. Check provider changes independently of the calendar screen. Use a separate app profile and synthetic tasks and events for automated runs.

| Journey | User action | Observable result |
| --- | --- | --- |
| 1. Connect my calendars | Connect TickTick and Google. Select task lists and several Google calendars. Leave the dedicated TickTick copy calendar off. Select one BMW source and mark it read-only, or select a Mac system calendar. | The day shows original TickTick tasks, Google appointments and BMW meetings together. A copied task appears only once. The selected sources survive restarting the app. |
| 2. See the shape of my day | Open Today, switch to full Week, then Next X Days. Change the day count, move across dates and scroll through the hours. | Week shows Monday through Sunday. Next X Days starts at the selected day. Day headers and the time ruler identify the visible time. Overlapping meetings are individually accessible. A dated task without a time appears in the all-day area. |
| 3. Plan an existing TickTick task | Drag a dated task from the all-day area to a time slot. Resize it, move it to another day, then complete it. | The original task keeps its provider ID, title, notes and checklist. Its start, end and completion change in TickTick. Refreshing or reopening shows the provider result. |
| 4. Create both kinds of item | Create a TickTick task in a chosen list and a Google appointment on a chosen writable calendar. | Each source contains one new item with the entered title and dates. Both items appear after refresh and restart. A read-only calendar cannot be the destination. |
| 5. Reschedule a Google event | Move an existing appointment and resize one end. Try an event that changed elsewhere and a meeting with guests. | The provider stores the new times on the original event. Unedited fields survive. A stale edit cannot overwrite the newer event. A change affecting guests requires an explicit review. A recurring edit identifies the affected occurrence. |
| 6. Hide, restore or delete | Right-click a Google or BMW meeting and hide it. Restart, restore it, then delete an eligible Google event after confirming the source action. | Hiding persists locally and leaves the source intact. Restoring makes the same meeting visible. Deletion removes the event at Google. The BMW source stays read-only even if its underlying copy is writable. |
| 7. Recover from a failed connection or unclear write | Refresh with one source unavailable. Try an edit that fails. Create a TickTick task when the provider accepts it without returning its ID, then reopen the app. | The last loaded data and source status remain visible. Other sources keep working. The app distinguishes failure from an unclear outcome and prevents an automatic duplicate create. Refresh can recover a connection. |
| 8. Organize my TickTick account | Open the list picker, expand or search a folder, and select the lists to show. Toggle the account off and on. Try one calendar per folder and a named calendar containing lists from different folders. Create a task in one of those lists. | A new account starts as one calendar containing Inbox and all active task lists. Folders and loose lists appear in their native order. Filters survive toggles and restart. Each task appears once and writes to its original list. Upgrading preserves earlier list selections. |

## First-release defaults

In **Connect TickTick**, approve task access in the system browser. In **Connect Google**, choose Google calendars from macOS Internet Accounts, or use browser consent when the publisher has configured a Google desktop client. Both routes start without asking the user to supply developer credentials.

Use the Mac's local time zone. Open on today. A full week begins on Monday. Next X Days uses consecutive dates and an adjustable count. Use 15-minute increments for pointer edits and a 30-minute initial slot when giving an untimed task a time. Keep source selection, local hiding and connection credentials in the app's own profile.

For uncertain TickTick recurrence behavior, show recurring tasks and explain any editing limitation before a change. For BMW, the initial contract is read-only. Direct Exchange mailbox access and organizer edits remain on the [roadmap](../.scratch/first-mac-release/spec.md).

## Evidence

Exercise the installed or packaged desktop interface with real pointer and keyboard input. Read independent provider state to verify writes, record the app build and check restart behavior. Identify the provider boundary in every run. A local HTTP test service verifies the desktop and adapter paths. Live provider evidence additionally requires dedicated accounts or disposable calendars and lists connected to Calendar Central.
