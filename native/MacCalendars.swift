import EventKit
import Foundation

@main
struct MacCalendars {
    static func write(_ value: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        FileHandle.standardOutput.write(data)
    }

    static func dayFormatter(in zone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            guard args == ["sources"] || (args.count == 4 && args.first == "items") else {
                try write(["error": "Choose sources or a calendar and date range."])
                return
            }
            let store = EKEventStore()
            guard try await store.requestFullAccessToEvents() else {
                try write(["error": "Allow Calendar Central full calendar access in System Settings to read Mac calendars."])
                return
            }
            if args[0] == "sources" {
                let sources: [[String: Any]] = store.calendars(for: .event).map { calendar in
                    ["id": calendar.calendarIdentifier, "name": calendar.title, "writable": false]
                }
                try write(sources)
                return
            }
            let localDay = dayFormatter(in: .current)
            guard let calendar = store.calendar(withIdentifier: args[1]),
                  let start = localDay.date(from: args[2]), let end = localDay.date(from: args[3]), start < end else {
                try write(["error": "The selected Mac calendar or date range is unavailable."])
                return
            }
            let predicate = store.predicateForEvents(withStart: start, end: end, calendars: [calendar])
            let iso = ISO8601DateFormatter()
            let items: [[String: Any]] = store.events(matching: predicate).compactMap { event in
                guard event.status != .canceled, let start = event.startDate, let end = event.endDate else { return nil }
                let day = dayFormatter(in: event.timeZone ?? .current)
                let isRecurring = event.hasRecurrenceRules || event.isDetached
                let occurrence = isRecurring ? (event.occurrenceDate.map { "|" + iso.string(from: $0) } ?? "") : ""
                return ["id": (event.eventIdentifier ?? event.calendarItemIdentifier) + occurrence,
                        "title": event.title ?? "Busy", "allDay": event.isAllDay,
                        "start": event.isAllDay ? day.string(from: start) : iso.string(from: start),
                        "end": event.isAllDay ? day.string(from: end) : iso.string(from: end),
                        "version": iso.string(from: event.lastModifiedDate ?? start),
                        "recurring": isRecurring,
                        "hasAttendees": event.hasAttendees, "canEdit": false,
                        "canDelete": false, "canComplete": false, "completed": false]
            }
            try write(items)
        } catch {
            try? write(["error": error.localizedDescription])
        }
    }
}
