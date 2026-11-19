import EventKit
import Foundation

@main
struct LiveEventProbe {
    struct Request: Decodable {
        let action: String
        let id: String
        let list: String
        let title: String
        let fromStart: String?
        let fromEnd: String?
        let toStart: String?
        let toEnd: String?
    }

    static func inspect(_ request: Request) async throws -> [String: Any] {
        guard !request.id.isEmpty, request.title.hasPrefix("Calendar Hub test ") else {
            return ["error": "invalid test target"]
        }
        let store = EKEventStore()
        guard try await store.requestFullAccessToEvents() else {
            return ["unavailable": "The independent EventKit probe needs Calendar access."]
        }
        guard let calendar = store.calendar(withIdentifier: request.list) else {
            return ["error": "the designated calendar is unavailable"]
        }
        if request.action == "access" { return ["available": true] }
        let parts = request.id.split(separator: ":", maxSplits: 1)
        guard parts.count == 2, let bytes = Data(base64Encoded: String(parts[1])),
              let identifier = String(data: bytes, encoding: .utf8), !identifier.isEmpty else {
            return ["error": "unknown EventKit item ID"]
        }
        let matches: [EKEvent]
        switch parts[0] {
        case "uid":
            matches = store.calendarItems(withExternalIdentifier: identifier).compactMap { $0 as? EKEvent }
                .filter { $0.calendar.calendarIdentifier == calendar.calendarIdentifier }
        case "local":
            let event = store.calendarItem(withIdentifier: identifier) as? EKEvent
            matches = event.flatMap { $0.calendar.calendarIdentifier == calendar.calendarIdentifier ? [$0] : nil } ?? []
        default:
            return ["error": "unknown EventKit item ID"]
        }
        guard !matches.isEmpty else { return ["missing": true] }
        guard matches.count == 1, let event = matches.first, event.title == request.title else {
            return ["error": "run-specific event identity changed"]
        }
        if event.status == .canceled { return ["missing": true] }
        guard !event.hasAttendees, !event.hasRecurrenceRules, !event.isDetached else {
            return ["error": "event acquired guests or recurrence"]
        }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let start = event.startDate, let end = event.endDate else { return ["error": "event dates are unavailable"] }
        if request.action == "read" {
            var result: [String: Any] = ["allDay": event.isAllDay, "start": iso.string(from: start), "end": iso.string(from: end)]
            result["externalId"] = event.calendarItemExternalIdentifier
            return result
        }
        guard request.action == "move", !event.isAllDay, calendar.allowsContentModifications,
              event.organizer?.isCurrentUser != false,
              request.fromStart.flatMap(iso.date(from:)) == start, request.fromEnd.flatMap(iso.date(from:)) == end,
              let newStart = request.toStart.flatMap(iso.date(from:)), let newEnd = request.toEnd.flatMap(iso.date(from:)),
              newStart < newEnd else { return ["error": "event owner or original times changed"] }
        event.startDate = newStart
        event.endDate = newEnd
        try store.save(event, span: .thisEvent, commit: true)
        return ["sent": true]
    }

    static func main() async {
        do {
            guard CommandLine.arguments.count == 2 else { throw CocoaError(.fileReadInvalidFileName) }
            let request = try JSONDecoder().decode(Request.self, from: Data(CommandLine.arguments[1].utf8))
            let result = try await inspect(request)
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
        } catch {
            print(#"{"error":"The independent EventKit operation did not finish. Check the disposable event before retrying."}"#)
        }
    }
}
