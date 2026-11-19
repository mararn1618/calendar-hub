import EventKit
import Foundation

@main
struct MacCalendarTests {
    static func expect(_ check: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !check() { throw NSError(domain: "MacCalendarTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }

    static func rejects(_ code: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch let error as CalendarFailure { try expect(error.code == code, "Unexpected failure: " + error.code); return }
        try expect(false, "Expected rejection: " + code)
    }

    static func rejectsCommand(_ args: [String], with code: String) async throws {
        do { _ = try await MacCalendars.run(args) }
        catch let error as CalendarFailure { try expect(error.code == code, "Unexpected failure: " + error.code); return }
        try expect(false, "Expected rejection: " + code)
    }

    static func main() async throws {
        let dates = CalendarDates(zone: TimeZone(identifier: "Europe/Berlin")!)
        let spring = Draft(title: "Holiday", start: "2026-03-29", end: "2026-03-30", allDay: true)
        let autumn = Draft(title: "Holiday", start: "2026-10-25", end: "2026-10-26", allDay: true)
        let (first, last) = try dates.bounds(spring), (fallFirst, fallLast) = try dates.bounds(autumn)
        try expect(last.timeIntervalSince(first) == 23 * 3600, "Spring all-day boundary")
        try expect(fallLast.timeIntervalSince(fallFirst) == 25 * 3600, "Autumn all-day boundary")
        try expect(dates.text(first, allDay: true) == spring.start, "All-day start")
        try expect(dates.text(last, allDay: true) == spring.end, "Exclusive all-day end")
        try rejects("INVALID") { _ = try dates.date("2026-02-30", allDay: true) }
        try rejects("INVALID") { _ = try dates.bounds(Draft(title: "End first", start: spring.end, end: spring.start, allDay: true)) }

        let reviewed = Change(original: nil, draft: nil, notify: true, occurrence: true)
        let member = EventRights(calendarAllows: true, organizerIsCurrent: false, hasAttendees: true, recurring: true, knownOccurrence: true)
        try rejects("READ_ONLY") { try member.review(reviewed) }
        let unknown = EventRights(calendarAllows: true, organizerIsCurrent: nil, hasAttendees: true, recurring: false, knownOccurrence: false)
        try rejects("READ_ONLY") { try unknown.review(reviewed) }
        let series = EventRights(calendarAllows: true, organizerIsCurrent: true, hasAttendees: false, recurring: true, knownOccurrence: false)
        try rejects("READ_ONLY") { try series.review(reviewed) }
        let readOnly = EventRights(calendarAllows: false, organizerIsCurrent: true, hasAttendees: false, recurring: false, knownOccurrence: false)
        try rejects("READ_ONLY") { try readOnly.review(reviewed) }
        let meeting = EventRights(calendarAllows: true, organizerIsCurrent: true, hasAttendees: true, recurring: true, knownOccurrence: true)
        try rejects("REVIEW_REQUIRED") { try meeting.review(Change(original: nil, draft: nil, notify: false, occurrence: true)) }
        try rejects("REVIEW_REQUIRED") { try meeting.review(Change(original: nil, draft: nil, notify: true, occurrence: false)) }
        try meeting.review(reviewed)
        let solo = EventRights(calendarAllows: true, organizerIsCurrent: nil, hasAttendees: false, recurring: false, knownOccurrence: false)
        try solo.review(Change(original: nil, draft: nil, notify: nil, occurrence: nil))

        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.notes = "Original fixture notes"
        event.location = "Original fixture room"
        let timed = Draft(title: "Appointment", start: "2026-03-29T08:00:00.000Z", end: "2026-03-29T09:00:00.000Z", allDay: false)
        try dates.apply(timed, to: event, creating: true)
        try expect(event.timeZone?.identifier == "Europe/Berlin" && !event.isAllDay, "New timed appointment")
        event.timeZone = TimeZone(identifier: "America/New_York")
        let resized = Draft(title: timed.title, start: timed.start, end: "2026-03-29T09:30:00.000Z", allDay: false)
        try dates.apply(resized, to: event, creating: false)
        try expect(event.timeZone?.identifier == "America/New_York", "Resize retained the event time zone")
        try expect(event.notes == "Original fixture notes" && event.location == "Original fixture room", "Resize retained the notes and location")
        try expect(dates.text(event.endDate, allDay: false) == resized.end, "New end instant")
        try dates.apply(spring, to: event, creating: false)
        try expect(event.isAllDay && dates.text(event.endDate, allDay: true) == spring.end, "Timed to all-day conversion")

        let google = CalendarScope(accountId: "account-a", googleCalendarIds: ["allowed", "moved"])
        try expect(google.includes(.google, sourceType: .calDAV, calendarType: .calDAV, account: "account-a", calendar: "allowed"), "Selected Google calendar")
        try expect(!google.includes(.google, sourceType: .calDAV, calendarType: .calDAV, account: "account-b", calendar: "moved"), "Calendar moved to another account")
        try expect(!google.includes(.google, sourceType: .calDAV, calendarType: .calDAV, account: "account-a", calendar: "other"), "Unselected Google calendar")
        try expect(!google.includes(.google, sourceType: .exchange, calendarType: .calDAV, account: "account-a", calendar: "allowed"), "Wrong source type")
        let exchange = CalendarScope(accountId: "account-b", googleCalendarIds: nil)
        try expect(exchange.includes(.exchange, sourceType: .exchange, calendarType: .exchange, account: "account-b", calendar: "work"), "Selected Exchange account")
        try expect(!exchange.includes(.exchange, sourceType: .exchange, calendarType: .exchange, account: "account-a", calendar: "work"), "Wrong Exchange account")
        try expect(!exchange.includes(.exchange, sourceType: .calDAV, calendarType: .calDAV, account: "account-b", calendar: "work"), "Wrong Exchange source type")

        for status in [EKAuthorizationStatus.notDetermined, .restricted, .denied, .writeOnly] {
            try rejects("PERMISSION") { _ = try MacCalendars.needsAccessRequest(for: "accounts", status: status) }
        }
        try expect(!MacCalendars.needsAccessRequest(for: "accounts", status: .fullAccess), "Inventory uses existing full access")
        try expect(MacCalendars.needsAccessRequest(for: "authorize", status: .notDetermined), "Explicit setup can request access")

        for route in ["mac", "exchange"] {
            for action in ["create", "update", "remove"] {
                try await rejectsCommand([action, route, "fixture", #"{"accountId":"account-b"}"#], with: "READ_ONLY")
            }
        }
        for args in [["items", "exchange", "work", "2026-11-20", "2026-11-21"],
                     ["create", "google", "work"],
                     ["create", "google", "work", #"{"accountId":"account-b"}"#]] {
            try await rejectsCommand(args, with: "INVALID")
        }
        for action in ["items", "create", "update", "remove"] {
            let dates = action == "items" ? ["2026-11-20", "2026-11-21"] : []
            let args = [action, "google", "other"] + dates + [#"{"accountId":"account-a","googleCalendarIds":["allowed"]}"#]
            try await rejectsCommand(args, with: "UNSELECTED")
        }
    }
}
