import CryptoKit
import EventKit
import Foundation

typealias CalendarRow = [String: Any]

enum Route: String { case mac, google, exchange }

struct CalendarScope: Decodable {
    let accountId: String?
    let googleCalendarIds: Set<String>?

    func includes(_ route: Route, sourceType: EKSourceType?, calendarType: EKCalendarType,
                  account: String?, calendar: String) -> Bool {
        if let accountId, accountId != account { return false }
        switch route {
        case .mac: return true
        case .google:
            return sourceType == .calDAV && calendarType == .calDAV && (googleCalendarIds?.contains(calendar) ?? true)
        case .exchange: return sourceType == .exchange
        }
    }
}

struct CalendarFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
    static let conflict = Self("CONFLICT", "This event changed in Mac Calendar. Refresh before editing it again.")
    static let readOnly = Self("READ_ONLY", "This calendar or event is read-only.")
    static let uncertain = Self("UNCERTAIN", "Mac Calendar may have saved the change. Check the calendar before trying again.")
    static let permission = Self("PERMISSION", "Allow Calendar Hub full calendar access in System Settings under Privacy & Security, then Calendars.")
    static let invalid = Self("INVALID", "Check the event title, dates and calendar selection.")
}

struct Original: Decodable {
    let id: String, version: String, start: String
    let allDay: Bool
}

struct Draft: Decodable {
    let title: String, start: String, end: String
    let allDay: Bool
}

struct Change: Decodable {
    let original: Original?, draft: Draft?, notify: Bool?, occurrence: Bool?
}

struct CalendarDates {
    let zone: TimeZone
    let days: DateFormatter
    let seconds = ISO8601DateFormatter()
    let precise = ISO8601DateFormatter()

    init(zone: TimeZone = .current) {
        self.zone = zone
        days = DateFormatter()
        days.locale = Locale(identifier: "en_US_POSIX")
        days.calendar = Calendar(identifier: .gregorian)
        days.timeZone = zone
        days.dateFormat = "yyyy-MM-dd"
        days.isLenient = false
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }

    func date(_ text: String, allDay: Bool) throws -> Date {
        if allDay {
            if let day = days.date(from: text), days.string(from: day) == text { return day }
        } else if let instant = precise.date(from: text) ?? seconds.date(from: text) { return instant }
        throw CalendarFailure.invalid
    }

    func text(_ date: Date, allDay: Bool) -> String {
        allDay ? days.string(from: date) : precise.string(from: date)
    }

    func bounds(_ draft: Draft) throws -> (Date, Date) {
        let start = try date(draft.start, allDay: draft.allDay), end = try date(draft.end, allDay: draft.allDay)
        guard !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, start < end else { throw CalendarFailure.invalid }
        return (start, end)
    }

    func apply(_ draft: Draft, to event: EKEvent, creating: Bool) throws {
        let (start, end) = try bounds(draft)
        if creating || (event.title ?? "Busy") != draft.title { event.title = draft.title }
        if creating || event.isAllDay != draft.allDay {
            event.isAllDay = draft.allDay
            event.timeZone = draft.allDay ? nil : zone
        }
        if creating || event.startDate != start { event.startDate = start }
        if creating || event.endDate != end { event.endDate = end }
    }
}

struct EventRights {
    let writable: Bool, guests: Bool, recurring: Bool

    init(calendarAllows: Bool, organizerIsCurrent: Bool?, hasAttendees: Bool, recurring: Bool, knownOccurrence: Bool) {
        self.guests = hasAttendees
        self.recurring = recurring
        let mayOrganize = organizerIsCurrent ?? !hasAttendees
        writable = calendarAllows && mayOrganize && (!recurring || knownOccurrence)
    }

    func review(_ change: Change) throws {
        guard writable else { throw CalendarFailure.readOnly }
        if guests && change.notify != true { throw CalendarFailure("REVIEW_REQUIRED", "Review this change and allow updates to guests.") }
        if recurring && change.occurrence != true { throw CalendarFailure("REVIEW_REQUIRED", "Confirm the change to this occurrence.") }
    }
}

struct NativeCalendars {
    let store: EKEventStore
    let dates = CalendarDates()
    let route: Route
    let scope: CalendarScope

    func includes(_ calendar: EKCalendar) -> Bool {
        scope.includes(route, sourceType: calendar.source?.sourceType, calendarType: calendar.type,
                       account: calendar.source?.sourceIdentifier, calendar: calendar.calendarIdentifier)
    }

    func writable(_ calendar: EKCalendar) -> Bool {
        route == .google && includes(calendar) && calendar.allowsContentModifications && !calendar.isSubscribed
    }

    func sources() -> [CalendarRow] {
        store.calendars(for: .event).filter(includes).map { calendar in
            ["id": calendar.calendarIdentifier, "name": calendar.title, "accountId": calendar.source?.sourceIdentifier ?? "",
             "accountName": calendar.source?.title ?? "", "writable": writable(calendar)]
        }
    }

    func calendar(_ id: String) throws -> EKCalendar {
        guard let calendar = store.calendar(withIdentifier: id), calendar.allowedEntityTypes.contains(.event),
              includes(calendar) else {
            throw CalendarFailure("UNAVAILABLE", "This calendar is no longer available. Choose it again in Calendar Hub.")
        }
        return calendar
    }

    func rights(_ event: EKEvent) -> EventRights {
        let allowed = event.calendar.map(writable) ?? false
        return EventRights(calendarAllows: allowed && event.birthdayContactIdentifier == nil,
                           organizerIsCurrent: event.organizer?.isCurrentUser, hasAttendees: event.hasAttendees,
                           recurring: event.hasRecurrenceRules || event.isDetached, knownOccurrence: event.occurrenceDate != nil)
    }

    func occurrenceKey(_ event: EKEvent) -> String {
        guard event.hasRecurrenceRules || event.isDetached, let date = event.occurrenceDate else { return "" }
        var floating = event.isAllDay
        if event.isDetached, let uid = event.calendarItemExternalIdentifier {
            let first = store.calendarItems(withExternalIdentifier: uid).compactMap { $0 as? EKEvent }.first {
                $0.calendar.calendarIdentifier == event.calendar.calendarIdentifier && !$0.isDetached && $0.hasRecurrenceRules
            }
            if let first { floating = first.isAllDay }
        }
        return "|" + dates.text(date, allDay: floating)
    }

    func identity(_ event: EKEvent) -> String {
        if route != .google {
            let recurring = event.hasRecurrenceRules || event.isDetached
            let occurrence = recurring ? (event.occurrenceDate.map { "|" + dates.seconds.string(from: $0) } ?? "") : ""
            return (event.eventIdentifier ?? event.calendarItemIdentifier) + occurrence
        }
        let external = event.calendarItemExternalIdentifier.flatMap { $0.isEmpty ? nil : $0 }
        let value = external ?? event.calendarItemIdentifier
        return (external == nil ? "local:" : "uid:") + Data(value.utf8).base64EncodedString() + occurrenceKey(event)
    }

    func revision(_ event: EKEvent, id: String) throws -> String {
        let fields: CalendarRow = [
            "id": id, "calendar": event.calendar.calendarIdentifier, "title": event.title ?? "",
            "start": event.startDate.timeIntervalSinceReferenceDate, "end": event.endDate.timeIntervalSinceReferenceDate,
            "allDay": event.isAllDay, "zone": event.timeZone?.identifier ?? "", "status": event.status.rawValue,
            "modified": event.lastModifiedDate?.timeIntervalSinceReferenceDate as Any, "location": event.location ?? "",
            "notes": event.notes ?? "", "url": event.url?.absoluteString ?? "", "recurring": event.hasRecurrenceRules || event.isDetached,
            "organizer": event.organizer?.url.absoluteString ?? "", "organizes": event.organizer?.isCurrentUser as Any,
            "guests": (event.attendees ?? []).map { $0.url.absoluteString + "|" + String($0.participantStatus.rawValue) }.sorted()
        ]
        let encoded = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        return SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
    }

    func row(_ event: EKEvent) throws -> CalendarRow {
        guard let start = event.startDate, let end = event.endDate, let calendar = event.calendar, includes(calendar),
              event.status != .canceled else { throw CalendarFailure.conflict }
        let id = identity(event), rights = rights(event)
        let version = route == .google ? try revision(event, id: id) : dates.seconds.string(from: event.lastModifiedDate ?? start)
        var result: CalendarRow = [
            "id": id, "providerCalendarId": calendar.calendarIdentifier, "title": event.title ?? "Busy", "allDay": event.isAllDay,
            "start": dates.text(start, allDay: event.isAllDay), "end": dates.text(end, allDay: event.isAllDay), "version": version,
            "recurring": rights.recurring, "hasAttendees": rights.guests, "canEdit": rights.writable, "canDelete": rights.writable,
            "canComplete": false, "completed": false
        ]
        if route == .google, let external = event.calendarItemExternalIdentifier { result["externalId"] = external }
        return result
    }

    func events(_ calendar: EKCalendar, from: Date, until: Date) -> [EKEvent] {
        let predicate = store.predicateForEvents(withStart: from, end: until, calendars: [calendar])
        return store.events(matching: predicate).filter {
            $0.calendar?.calendarIdentifier == calendar.calendarIdentifier && $0.status != .canceled && $0.startDate != nil && $0.endDate != nil
        }
    }

    func existing(_ original: Original, on calendar: EKCalendar) throws -> EKEvent {
        let start = try dates.date(original.start, allDay: original.allDay)
        let matches = events(calendar, from: start.addingTimeInterval(-1), until: start.addingTimeInterval(1)).filter { identity($0) == original.id }
        guard matches.count == 1, let event = matches.first, event.refresh(), event.status != .canceled,
              event.calendar?.calendarIdentifier == calendar.calendarIdentifier, identity(event) == original.id,
              try revision(event, id: original.id) == original.version else { throw CalendarFailure.conflict }
        return event
    }

    func commit(_ operation: () throws -> Void) throws {
        do { try operation() }
        catch let error as NSError {
            guard error.domain == EKErrorDomain else { throw CalendarFailure.uncertain }
            switch EKError.Code(rawValue: error.code) {
            case .eventNotMutable, .calendarReadOnly, .invitesCannotBeMoved: throw CalendarFailure.readOnly
            case .eventStoreNotAuthorized: throw CalendarFailure.permission
            case .noStartDate, .noEndDate, .datesInverted, .durationGreaterThanRecurrence,
                 .startDateCollidesWithOtherOccurrence, .startDateTooFarInFuture, .invalidSpan:
                throw CalendarFailure("INVALID", error.localizedDescription)
            default: throw CalendarFailure.uncertain
            }
        }
    }

    func change(_ action: String, on calendar: EKCalendar, input: Change) throws -> CalendarRow {
        guard writable(calendar) else { throw CalendarFailure.readOnly }
        let event: EKEvent
        if action == "create" {
            guard input.original == nil else { throw CalendarFailure.invalid }
            event = EKEvent(eventStore: store)
            event.calendar = calendar
        } else {
            guard let original = input.original else { throw CalendarFailure.invalid }
            event = try existing(original, on: calendar)
            try rights(event).review(input)
        }
        if action == "remove" {
            try commit { try store.remove(event, span: .thisEvent, commit: true) }
            return ["removed": true]
        }
        guard let draft = input.draft else { throw CalendarFailure.invalid }
        let new = action == "create"
        try dates.apply(draft, to: event, creating: new)
        if new || event.hasChanges { try commit { try store.save(event, span: .thisEvent, commit: true) } }
        guard event.calendar?.calendarIdentifier == calendar.calendarIdentifier, let savedID = event.eventIdentifier,
              !savedID.isEmpty else { throw CalendarFailure.uncertain }
        do { return try row(event) } catch { throw CalendarFailure.uncertain }
    }
}

#if !MAC_CALENDAR_TESTS
@main
#endif
struct MacCalendars {
    static func output(_ result: Any) throws {
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
    }

    static func needsAccessRequest(for action: String, status: EKAuthorizationStatus) throws -> Bool {
        if status == .fullAccess { return false }
        guard action == "authorize", status != .denied, status != .restricted else { throw CalendarFailure.permission }
        return true
    }

    static func run(_ args: [String]) async throws -> Any {
        guard let action = args.first else { throw CalendarFailure.invalid }
        let oldRead = args == ["sources"] || (action == "items" && args.count == 4)
        let parts = oldRead ? Array(args.prefix(1)) + ["mac"] + Array(args.dropFirst()) : args
        let lengths = ["authorize": 2, "accounts": 2, "sources": 2, "items": 5, "create": 3, "update": 3, "remove": 3]
        guard let length = lengths[action], parts.count == length || parts.count == length + 1,
              let route = Route(rawValue: parts[1]) else { throw CalendarFailure.invalid }
        let writing = ["create", "update", "remove"].contains(action)
        if writing && route != .google { throw CalendarFailure.readOnly }
        let scope: CalendarScope
        if parts.count > length {
            guard let requested = try? JSONDecoder().decode(CalendarScope.self, from: Data(parts[length].utf8)),
                  requested.accountId?.isEmpty != true else { throw CalendarFailure.invalid }
            scope = requested
        } else {
            scope = CalendarScope(accountId: nil, googleCalendarIds: nil)
        }
        let accountInventory = action == "authorize" || action == "accounts"
        if route == .exchange && !accountInventory && scope.accountId == nil { throw CalendarFailure.invalid }
        if route == .google && !accountInventory {
            guard let selected = scope.googleCalendarIds else { throw CalendarFailure.invalid }
            if action != "sources" && !selected.contains(parts[2]) {
                throw CalendarFailure("UNSELECTED", "Choose this calendar in the Google setup on this Mac.")
            }
        }
        let requestAccess = try needsAccessRequest(for: action, status: EKEventStore.authorizationStatus(for: .event))
        let store = EKEventStore()
        if requestAccess {
            guard try await store.requestFullAccessToEvents() else { throw CalendarFailure.permission }
        }
        let native = NativeCalendars(store: store, route: route, scope: scope)
        if accountInventory || action == "sources" { return native.sources() }
        let calendar = try native.calendar(parts[2])
        if action == "items" {
            let from = try native.dates.date(parts[3], allDay: true), until = try native.dates.date(parts[4], allDay: true)
            guard from < until else { throw CalendarFailure.invalid }
            return try native.events(calendar, from: from, until: until).map(native.row)
        }
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let input = try? JSONDecoder().decode(Change.self, from: data) else { throw CalendarFailure.invalid }
        return try native.change(action, on: calendar, input: input)
    }

    static func main() async {
        do { try output(await run(Array(CommandLine.arguments.dropFirst()))) }
        catch let error as CalendarFailure { try? output(["error": error.message, "code": error.code]) }
        catch { try? output(["error": error.localizedDescription, "code": "NATIVE"]) }
    }
}
