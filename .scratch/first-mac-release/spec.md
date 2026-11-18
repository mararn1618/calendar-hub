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

## BMW calendar roadmap

1. **First release.** Show BMW meetings read-only through the existing workaround. The Mac calendar and Google Calendar are possible routes.
2. **Direct reading.** Investigate reading the original Exchange calendar. Identify available routes, the access each needs and how to check which the company permits.
3. **Editing.** Explore moving and resizing meetings where the account permits it. Distinguish meetings the user organizes from invitations received from someone else.

## Platforms

The first release is for personal use on macOS. Windows is a possible later release. Mobile and the separate Google Tasks service are outside the current scope.
