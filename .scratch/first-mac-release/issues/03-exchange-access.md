# Which routes could read the BMW calendar on Mac?

Type: research
Label: wayfinder:research
Status: resolved
Assignee: Markus

## Question

What can a Mac app read through the existing Google or Mac calendar workaround, through the Mac system calendar with an Exchange account, and directly through an approved Microsoft connection? Identify the setup needed for each, who can grant access, freshness and write limits, and the evidence required to choose a route for this particular account. Cover moving organizer-owned meetings and handling received invitations as later roadmap options. Use public sources without contacting the company or accessing an account.

## Answer

A Google copy or Mac calendar can supply read-only meetings for the first release. A file import is a snapshot. A Microsoft 365 calendar subscribed to through Google can take 24 to 48 hours to reflect changes. The existing workaround's actual method and delay are unknown. Comparing a meeting that has already moved in Outlook would establish whether the chosen feed is useful for daily planning. [Microsoft calendar sharing](https://support.microsoft.com/en-us/outlook/calendar-sharing-in-microsoft-365)

EventKit can read an Exchange calendar already syncing through Apple Calendar if the user grants calendar access. Since October 2026, affected Exchange Online accounts using Apple Internet Accounts may need an administrator to keep that connection syncing. For an Exchange Online mailbox, an approved Microsoft Graph connection can read meetings directly with delegated access. BMW's account type and permitted connection are unverified. [Apple Exchange notice](https://support.apple.com/en-us/149092) · [Microsoft Graph calendar view](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)

For the editing roadmap, sending an organizer's time change can notify guests. An invited attendee can propose a time if the organizer permits proposals. The report lists the permissions and evidence needed at each step. [Reading the BMW calendar on Mac](../../../../.calendar-central-exchange-research/docs/research/exchange-on-mac.md)

Research branch `research/exchange-on-mac`, commit `b662350a87f331e4ff4a3e85c3716093998de12b`. The report is also available with `git show b662350:docs/research/exchange-on-mac.md`.
