# Calendar Central on Mac

Working specification, 18 November 2026. The [decision map](map.md) tracks the remaining questions.

## First release

On a workday, I can open one calendar on my Mac and see my TickTick tasks, appointments from my Google calendars and BMW meetings together. I can plan my day here and see my edits when I reopen the app that owns each item.

The calendar has Day, full Week and Next X Days views. I can scroll horizontally across dates and vertically through the hours. The exact range choices, scroll behavior and any additional views are open.

## Acceptance examples

| When I use Calendar Central | What I expect to see |
| --- | --- |
| I look at a day with a TickTick task dated today, a timed task, a Google appointment and a BMW meeting. | The task without a time is visible for the day. The other three items appear at their times, including overlaps. |
| I drag today's untimed task to 10 am, change its duration, then check it off. | Opening TickTick shows the new times and completion on the same task. |
| I create a TickTick task and a Google event from the calendar. | The task appears in TickTick and the event appears on the Google calendar I chose. |
| I move a writable Google appointment and drag its end later. | Google Calendar shows the new start and end on the original appointment. |
| I right-click a meeting and choose **Hide in Calendar Central**. | The meeting disappears from my view. People using the source calendar still see it. |
| I right-click an eligible Google event and choose **Delete from Google**. | Deletion removes the event at Google. The menu distinguishes this action from hiding it locally. |
| I leave the dedicated Google calendar of TickTick copies unselected. | My original TickTick tasks appear once, alongside events from my other selected Google calendars. |

The public TickTick API documents original-task creation, edits, completion and dated Inbox reads. Test the same task in TickTick before and after a time change, including its notes and checklist. Single-time tasks, recurrence and the account's support for durations need particular attention. Daymark has verified live Google reads and tested Google writes with simulated responses. [TickTick findings](issues/02-ticktick-api.md) · [Daymark evidence](daymark.md)

## BMW calendar roadmap

1. **First release.** Show BMW meetings read-only through one selected source. Check that a meeting already moved in Outlook appears at the new time in the chosen Mac or Google calendar. The current copying method and its delay still need to be identified.
2. **Direct reading.** If the Exchange account already syncs to Apple Calendar, EventKit can read its local calendar. For an Exchange Online mailbox, an approved Microsoft Graph connection can read meetings directly. Which route the company permits is open. [Exchange access findings](issues/03-exchange-access.md)
3. **Editing.** Explore moving and resizing meetings the user organizes, including the update guests receive. For received invitations, evaluate proposing a new time where the organizer allows it. [Meeting permissions](issues/03-exchange-access.md)

## Platforms

The first release is for personal use on macOS. Windows is a possible later release. Mobile and the separate Google Tasks service are outside the current scope.
