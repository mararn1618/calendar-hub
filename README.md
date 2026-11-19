# Calendar Hub

**[Download Calendar Hub 0.5.0 for Mac](https://github.com/mararn1618/calendar-hub/releases/download/v0.5.0/Calendar-Hub-0.5.0-arm64.dmg)** · [All releases and previews](https://github.com/mararn1618/calendar-hub/releases)

A Mac calendar for TickTick tasks, Google appointments and read-only work meetings. Use Day, a Monday-to-Sunday Week or a rolling view of 1 to 31 days.

## Download for Mac

The public preview runs on Apple Silicon Macs with macOS 14 or later. Open the downloaded DMG, then drag **Calendar Hub** into **Applications**.

The preview uses an ad hoc signature without Apple notarization. macOS may require your approval the first time you open it. [Apple’s guide to opening downloaded apps](https://support.apple.com/en-us/102445)

## Calendar appearance

Open **Manage calendars → Appearance** and choose **Light** or **Dark**. Light is the default. Calendar Hub remembers your choice on this Mac. Each provider has a sidebar heading, with its connected accounts and calendars underneath.

Use the color control beside any calendar to change its sidebar marker and its entries on the timeline. Colors are local to Calendar Hub. TickTick calendars can have separate colors in the account, folder and custom layouts.

The rolling view shows your chosen length, for example **Next 5 Days**. When you switch views, entries already loaded for those dates stay visible while the app checks for updates.

## Create an appointment

Drag from the start time to the end time on an empty part of the calendar. The preview snaps to 15 minutes. Release, enter a title, choose a Google calendar and press **Save**. You can drag across midnight or across several dates in the all-day row. **Escape** cancels the selection. Use **New item** to create a TickTick task or enter an appointment using the keyboard.

## Run on this Mac

Install the dependencies with `npm ci`. Run `npm start` for the development app or `npm run package:mac` to build a standalone Mac app. Packaging requires the Xcode Command Line Tools. The Apple Silicon build opens from [Calendar Hub.app](<build/packaged/Calendar Hub-darwin-arm64/Calendar Hub.app>).

Run `npm run package:dmg` after packaging to build and verify the installer. Maintainers publish a preview by pushing its version tag. [Release process](docs/releases.md)

## Connect calendars

Open **Manage calendars** and choose a provider under **Add an account**. Repeat for each Google, TickTick or Exchange account. You can name accounts **Work** and **Personal**, for example. The sidebar, new-item picker and account settings use these names. **Rename** changes the local label. **Disconnect** removes that account from Calendar Hub.

- **TickTick**. Choose **Manage calendars → Connect TickTick → Continue with TickTick**. Approve task access in your browser. Your account appears as one calendar. Each new connection includes Inbox and all active task lists. Existing connections keep their list selection. Use **Reconnect** to renew access. A personal API token is also available as a manual option. [TickTick authorization service](https://ticktick.com/.well-known/oauth-authorization-server) · [Task permissions](https://developer.ticktick.com/docs/openapi.md)
- **Google on this Mac**. Choose **Connect Google Calendar → Choose Google calendars on this Mac**. Apple lists its CalDAV accounts here, including iCloud. Select the account you set up with Google and pick its calendars. Repeat for another Google account. If an account is missing, choose **Open Internet Accounts**, add Google, turn on **Calendars**, then choose **Check again**. Apple Calendar syncs changes to the selected account. [Apple’s calendar account guide](https://support.apple.com/guide/calendar/add-or-delete-calendar-accounts-icl4308d6701/mac)
- **Exchange on this Mac**. Choose **Connect Exchange** and select the work account you use in Apple Calendar. Its calendars appear under that account and its meetings are read-only. Repeat for another Exchange account.
- **Work meetings**. Select one Google copy and mark it **Read-only**, or choose **Connect Mac calendars** to display meetings from Apple Calendar as read-only. Leave the separate Google calendar of TickTick copies unchecked to show the original tasks once.

For a build that connects directly to the Google Calendar API, the app publisher enables that API, registers one **Desktop app** OAuth client and sets `CALENDAR_HUB_GOOGLE_DESKTOP_CONFIG` to the downloaded JSON file when running `npm run package:mac`. For an external project in Testing, the publisher adds the testers in **Google Auth Platform → Audience → Test users**. Users choose **Continue with Google** and select their account in the browser. The same desktop client works for each account. A self-built installation can also load its desktop client once in **Connect Google Calendar**. [Google desktop authorization](https://developers.google.com/identity/protocols/oauth2/native-app) · [Consent screen setup](https://developers.google.com/workspace/guides/configure-oauth-consent)

Older Google connections through Apple Calendar split into accounts when the Mac can identify the owner of each saved calendar. Selections, hidden events, reminder settings and pending edits follow their calendars.

Use one Google sign-in route per account to see its calendars once. TickTick uses the private Inbox to recognize an account when its access token changes. If TickTick cannot identify an empty Inbox, Calendar Hub keeps the saved connection and lets you add a separate one.

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

## Add a provider

Register its display name, item kind, sign-in routes and three methods. `authorize` obtains a grant, `identity` identifies the account and `client` creates an adapter for that grant. The adapter exposes `sources`, `items` and the write operations it supports. Calendar Hub stores each connection separately and sends edits to the connection that owns the selected calendar or list. [Built-in integrations](desktop/providers/integrations.mjs) · [Registry](desktop/providers/registry.mjs)

## Verify

- `npm test` runs the adapter, calendar and reminder checks. On a Mac, `node tests/mac-notifications-smoke.mjs` also checks the real notification API in a signed test app without requesting permission.
- `npm run package:mac` followed by `npm run test:e2e` exercises the packaged app with fresh profiles, test consent screens for both providers, independent HTTP services and a simulated Mac calendar store.
- `npm run test:live` opens the packaged app with its own real connections for an opt-in live run. Select the TickTick list and Google calendar where disposable items may be created. You can also name the destinations with `CALENDAR_LIVE_TICKTICK_LIST` and `CALENDAR_LIVE_GOOGLE_CALENDAR`. The runner uses unique titles and checks each original item. For Google through Apple Calendar it checks the local store. The live report links separate Google cloud evidence.

The [validation contract](docs/user-journeys.md) defines the critical journeys. The [Mac test results](docs/verification.md) link to the packaged run and live status. The [Mac specification](.scratch/first-mac-release/spec.md), [Exchange roadmap](.scratch/first-mac-release/issues/03-exchange-access.md) and [Daymark reference](.scratch/first-mac-release/daymark.md) record the product scope and reference evidence.
