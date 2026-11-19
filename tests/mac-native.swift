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

        do { _ = try await MacCalendars.run(["remove", "mac", "fixture"]) }
        catch let failure as CalendarFailure {
            try expect(failure.code == "READ_ONLY", "Generic Mac write")
            return
        }
        try expect(false, "Generic Mac route accepted a write")
    }
}
