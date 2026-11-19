# Calendar Central

A Mac calendar for TickTick tasks, Google appointments and read-only work meetings. Use Day, a Monday-to-Sunday Week or a rolling view of 1 to 31 days.

## Run on this Mac

Install the dependencies with `npm ci`. Run `npm start` for the development app or `npm run package:mac` to build a standalone Mac app. Packaging requires the Xcode Command Line Tools. The Apple Silicon build opens from [Calendar Central.app](<build/packaged/Calendar Central-darwin-arm64/Calendar Central.app>).

## Connect calendars

- **TickTick**. Choose **Manage calendars → Connect TickTick → Continue with TickTick**. Approve task access in your browser, then select the lists to show. Calendar Central registers itself automatically with TickTick. Use **Reconnect** to renew access to a saved account. A personal API token is also available as a manual option. [TickTick authorization service](https://ticktick.com/.well-known/oauth-authorization-server) · [Task permissions](https://developer.ticktick.com/docs/openapi.md)
- **Google on this Mac**. Choose **Connect Google → Choose Google calendars on this Mac**. Allow calendar access, then pick calendars under your Google account. If Google is missing, choose **Open Internet Accounts**, add Google, turn on **Calendars**, and choose **Check again**. A newly created Google calendar can take a few minutes to appear. Apple Calendar syncs your event changes to Google. [Apple’s calendar account guide](https://support.apple.com/guide/calendar/add-or-delete-calendar-accounts-icl4308d6701/mac)
- **Work meetings**. Select one Google copy and mark it **Read-only**, or choose **Connect Mac calendars** to display meetings from Apple Calendar as read-only. Leave the separate Google calendar of TickTick copies unchecked to show the original tasks once.

For a build that connects directly to the Google Calendar API, the app publisher enables that API, registers one **Desktop app** OAuth client and sets `CALENDAR_CENTRAL_GOOGLE_DESKTOP_CONFIG` to the downloaded JSON file when running `npm run package:mac`. For an external project in Testing, the publisher adds the testers in **Google Auth Platform → Audience → Test users**. Users then choose **Continue with Google** and approve calendar access in their browser. A self-built installation can also load its desktop client once in **Connect Google**. [Google desktop authorization](https://developers.google.com/identity/protocols/oauth2/native-app) · [Consent screen setup](https://developers.google.com/workspace/guides/configure-oauth-consent)

Calendar Central stores its profile under `~/Library/Application Support/Calendar Central`. Provider credentials are encrypted using macOS keychain-backed storage. In the calendar, right-click an appointment to hide it locally. **Hidden items** restores it. **Delete from Google** asks for confirmation before changing the source.

## Verify

- `npm test` runs the adapter and calendar checks.
- `npm run package:mac` followed by `npm run test:e2e` exercises the packaged app with fresh profiles, test consent screens for both providers, independent HTTP services and a simulated Mac calendar store.
- `npm run test:live` opens the packaged app with its own real connections for an opt-in live run. Select the TickTick list and Google calendar where disposable items may be created. You can also name the destinations with `CALENDAR_LIVE_TICKTICK_LIST` and `CALENDAR_LIVE_GOOGLE_CALENDAR`. The runner uses unique titles and checks each original item. For Google through Apple Calendar it checks the local store. The live report links separate Google cloud evidence.

The [validation contract](docs/user-journeys.md) defines the critical journeys. The [Mac test results](docs/verification.md) link to the packaged run and live status. The [Mac specification](.scratch/first-mac-release/spec.md), [Exchange roadmap](.scratch/first-mac-release/issues/03-exchange-access.md) and [Daymark reference](.scratch/first-mac-release/daymark.md) record the product scope and reference evidence.
