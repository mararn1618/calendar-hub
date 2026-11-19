# Calendar Central

A Mac calendar for TickTick tasks, Google appointments and read-only work meetings. Use Day, a Monday-to-Sunday Week or a rolling view of 1 to 31 days.

## Run on this Mac

Install the dependencies with `npm ci`. Run `npm start` for the development app or `npm run package:mac` to build a standalone Mac app. Packaging requires the Xcode Command Line Tools. The Apple Silicon build opens from [Calendar Central.app](<build/packaged/Calendar Central-darwin-arm64/Calendar Central.app>).

## Connect calendars

- **TickTick.** Open **Manage calendars**, choose **Connect TickTick**, and enter a personal API token from TickTick's web settings under **Account**. Select the lists you plan from. [TickTick Open API](https://developer.ticktick.com/docs/openapi.md)
- **Google.** Enable Google Calendar API in your Google Cloud project and create an OAuth client of type **Desktop app**. If the OAuth consent screen is in testing, add your Google account as a test user. Choose **Connect Google**, enter the desktop client details and complete the browser sign-in. Select the calendars to display. [Desktop authorization](https://developers.google.com/identity/protocols/oauth2/native-app) · [Enable the Calendar API](https://developers.google.com/workspace/calendar/api/quickstart/nodejs)
- **Work meetings.** Select one Google copy and mark it **Read-only**, or choose **Connect Mac calendars** for an account already syncing in Apple Calendar. Mac calendar sources are read-only. Leave the separate Google calendar of TickTick copies unchecked to show the original tasks once.

Calendar Central stores its profile under `~/Library/Application Support/Calendar Central`. Provider credentials are encrypted using macOS keychain-backed storage. In the calendar, right-click an appointment to hide it locally. **Hidden items** restores it. **Delete from Google** asks for confirmation before changing the source.

## Verify

- `npm test` runs the adapter and calendar checks.
- `npm run package:mac` followed by `npm run test:e2e` exercises the packaged app with a fresh profile, a Google test consent screen and independent HTTP test services.
- `npm run test:live` opens the packaged app with its own real connections for an opt-in live run. Select the TickTick list and Google calendar where disposable items may be created. The runner uses unique titles and verifies changes against those items.

The [validation contract](docs/user-journeys.md) defines the critical journeys. The [Mac test results](docs/verification.md) link to the packaged run and live status. The [Mac specification](.scratch/first-mac-release/spec.md), [Exchange roadmap](.scratch/first-mac-release/issues/03-exchange-access.md) and [Daymark reference](.scratch/first-mac-release/daymark.md) record the product scope and reference evidence.
