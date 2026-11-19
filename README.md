# Calendar Hub

A Mac calendar for TickTick tasks, Google appointments and read-only work meetings. Use Day, a Monday-to-Sunday Week or a rolling view of 1 to 31 days.

## Run on this Mac

Install the dependencies with `npm ci`. Run `npm start` for the development app or `npm run package:mac` to build a standalone Mac app. Packaging requires the Xcode Command Line Tools. The Apple Silicon build opens from [Calendar Hub.app](<build/packaged/Calendar Hub-darwin-arm64/Calendar Hub.app>).

## Connect calendars

- **TickTick**. Choose **Manage calendars → Connect TickTick → Continue with TickTick**. Approve task access in your browser. Your account appears as one calendar. Each new connection includes Inbox and all active task lists. Existing connections keep their list selection. Use **Reconnect** to renew access. A personal API token is also available as a manual option. [TickTick authorization service](https://ticktick.com/.well-known/oauth-authorization-server) · [Task permissions](https://developer.ticktick.com/docs/openapi.md)
- **Google on this Mac**. Choose **Connect Google → Choose Google calendars on this Mac**. Allow calendar access, then pick calendars under your Google account. If Google is missing, choose **Open Internet Accounts**, add Google, turn on **Calendars**, and choose **Check again**. A newly created Google calendar can take a few minutes to appear. Apple Calendar syncs your event changes to Google. [Apple’s calendar account guide](https://support.apple.com/guide/calendar/add-or-delete-calendar-accounts-icl4308d6701/mac)
- **Work meetings**. Select one Google copy and mark it **Read-only**, or choose **Connect Mac calendars** to display meetings from Apple Calendar as read-only. Leave the separate Google calendar of TickTick copies unchecked to show the original tasks once.

For a build that connects directly to the Google Calendar API, the app publisher enables that API, registers one **Desktop app** OAuth client and sets `CALENDAR_HUB_GOOGLE_DESKTOP_CONFIG` to the downloaded JSON file when running `npm run package:mac`. For an external project in Testing, the publisher adds the testers in **Google Auth Platform → Audience → Test users**. Users then choose **Continue with Google** and approve calendar access in their browser. A self-built installation can also load its desktop client once in **Connect Google**. [Google desktop authorization](https://developers.google.com/identity/protocols/oauth2/native-app) · [Consent screen setup](https://developers.google.com/workspace/guides/configure-oauth-consent)

Calendar Hub uses the existing profile at `~/Library/Application Support/Calendar Central` so that upgrades retain connected accounts, list selections and reminder settings. Provider credentials are encrypted using macOS keychain-backed storage. In the calendar, right-click an appointment to hide it locally. **Hidden items** restores it. **Delete from Google** asks for confirmation before changing the source.

## Organize TickTick

Open **Manage calendars → Edit lists**. Folders and loose lists follow their order in TickTick. Expand a folder or search for a list, choose individual lists or a whole folder, then select **Save**.

- **One calendar** gives the account one checkbox in the sidebar. Turning it off and on remembers your list selection.
- **By folder** gives each folder a calendar and collects Inbox and loose lists together.
- **Custom calendars** lets you name calendars and combine lists from different folders. Each included list belongs to one calendar. New tasks still go to the TickTick list you choose when creating them.

## Calendar notifications

Click the bell beside a calendar to turn its Mac notifications on or off. Calendars start muted. On first use, allow notifications for Calendar Hub in macOS. The default lead is 10 minutes before a timed task or event.

Right-click the bell to choose a lead time, or open its notification settings under **Manage calendars** to enter a number of minutes. Zero means at the start. A calendar can send notifications while hidden from the timeline. These settings apply only to Calendar Hub.

The app schedules the next seven days of reminders with macOS, up to the nearest 64. Scheduled reminders can fire after you quit. Reopen the app to pick up source changes and fill the next week. A daily summary for all-day items is planned separately.

## Verify

- `npm test` runs the adapter, calendar and reminder checks. On a Mac, `node tests/mac-notifications-smoke.mjs` also checks the real notification API in a signed test app without requesting permission.
- `npm run package:mac` followed by `npm run test:e2e` exercises the packaged app with fresh profiles, test consent screens for both providers, independent HTTP services and a simulated Mac calendar store.
- `npm run test:live` opens the packaged app with its own real connections for an opt-in live run. Select the TickTick list and Google calendar where disposable items may be created. You can also name the destinations with `CALENDAR_LIVE_TICKTICK_LIST` and `CALENDAR_LIVE_GOOGLE_CALENDAR`. The runner uses unique titles and checks each original item. For Google through Apple Calendar it checks the local store. The live report links separate Google cloud evidence.

The [validation contract](docs/user-journeys.md) defines the critical journeys. The [Mac test results](docs/verification.md) link to the packaged run and live status. The [Mac specification](.scratch/first-mac-release/spec.md), [Exchange roadmap](.scratch/first-mac-release/issues/03-exchange-access.md) and [Daymark reference](.scratch/first-mac-release/daymark.md) record the product scope and reference evidence.
