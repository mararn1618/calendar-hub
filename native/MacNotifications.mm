#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#ifndef MAC_NOTIFICATION_TESTS
#include <node_api.h>
#include <memory>
#include <string>
#endif

static NSString *const reminderPrefix = @"calendar-central.reminder.";
static NSString *const signatureKey = @"calendar-central.signature";

@interface CalendarNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, weak) id<UNUserNotificationCenterDelegate> previous;
@end

@implementation CalendarNotificationDelegate
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.previous respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector {
    return [self.previous respondsToSelector:selector] ? self.previous : [super forwardingTargetForSelector:selector];
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    if ([notification.request.identifier hasPrefix:reminderPrefix]) {
        completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
    } else if ([self.previous respondsToSelector:_cmd]) {
        [self.previous userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completion];
    } else {
        completion(UNNotificationPresentationOptionNone);
    }
}
@end

typedef void (^Reply)(id value, NSString *error);

static void readAuthorization(UNUserNotificationCenter *center, Reply reply) {
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        switch (settings.authorizationStatus) {
            case UNAuthorizationStatusNotDetermined: reply(@"undetermined", nil); break;
            case UNAuthorizationStatusDenied: reply(@"denied", nil); break;
            case UNAuthorizationStatusAuthorized:
            case UNAuthorizationStatusProvisional: reply(@"allowed", nil); break;
            default: reply(@"unavailable", nil);
        }
    }];
}

static NSDictionary *ownedRecord(UNNotificationRequest *request) {
    if (![request.identifier hasPrefix:reminderPrefix]) return nil;
    return @{@"id": [request.identifier substringFromIndex:reminderPrefix.length],
             @"signature": request.content.userInfo[signatureKey] ?: NSNull.null};
}

static void readSchedule(UNUserNotificationCenter *center, Reply reply) {
    [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *requests) {
        NSMutableArray *pending = [NSMutableArray array];
        for (UNNotificationRequest *request in requests) {
            NSDictionary *record = ownedRecord(request);
            if (record) [pending addObject:record];
        }
        [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications) {
            NSMutableArray *delivered = [NSMutableArray array];
            for (UNNotification *notification in notifications) {
                NSDictionary *record = ownedRecord(notification.request);
                if (record) [delivered addObject:record];
            }
            reply(@{@"pending": pending, @"otherPending": @(requests.count - pending.count), @"delivered": delivered}, nil);
        }];
    }];
}

static void scheduleReminder(UNUserNotificationCenter *center, NSDictionary *row, Reply reply) {
    NSDate *date = [NSDate dateWithTimeIntervalSince1970:[row[@"seconds"] doubleValue]];
    if (date.timeIntervalSinceNow <= 0) { reply(NSNull.null, nil); return; }
    NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    NSCalendarUnit units = NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay |
        NSCalendarUnitHour | NSCalendarUnitMinute | NSCalendarUnitSecond;
    NSDateComponents *components = [calendar components:units fromDate:date];
    components.calendar = calendar;
    components.timeZone = calendar.timeZone;
    UNCalendarNotificationTrigger *trigger = [UNCalendarNotificationTrigger triggerWithDateMatchingComponents:components repeats:NO];
    UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
    content.title = row[@"title"];
    content.body = row[@"body"];
    content.sound = UNNotificationSound.defaultSound;
    content.userInfo = @{signatureKey: row[@"signature"]};
    NSString *identifier = [reminderPrefix stringByAppendingString:row[@"id"]];
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:trigger];
    [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
        reply(NSNull.null, error.localizedDescription);
    }];
}

static void perform(UNUserNotificationCenter *center, NSString *operation, id payload, Reply reply) {
    if (!center) {
        if ([operation isEqualToString:@"authorization"] || [operation isEqualToString:@"requestAuthorization"]) reply(@"unavailable", nil);
        else reply(nil, @"Open Calendar Hub to manage Mac notifications.");
        return;
    }
    static CalendarNotificationDelegate *delegate = [[CalendarNotificationDelegate alloc] init];
    if (center.delegate != delegate) {
        delegate.previous = center.delegate;
        center.delegate = delegate;
    }
    if ([operation isEqualToString:@"authorization"]) {
        readAuthorization(center, reply);
    } else if ([operation isEqualToString:@"requestAuthorization"]) {
        [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound
                              completionHandler:^(BOOL granted, NSError *error) {
            if (error) reply(nil, error.localizedDescription);
            else readAuthorization(center, reply);
        }];
    } else if ([operation isEqualToString:@"snapshot"]) {
        readSchedule(center, reply);
    } else if ([operation isEqualToString:@"cancel"]) {
        NSMutableArray *identifiers = [NSMutableArray array];
        for (NSString *identifier in payload) [identifiers addObject:[reminderPrefix stringByAppendingString:identifier]];
        [center removePendingNotificationRequestsWithIdentifiers:identifiers];
        reply(NSNull.null, nil);
    } else if ([operation isEqualToString:@"schedule"]) {
        scheduleReminder(center, payload, reply);
    } else {
        reply(nil, @"Unknown Mac notification request.");
    }
}

#ifndef MAC_NOTIFICATION_TESTS
struct Result {
    std::string json;
    std::string error;
};

static NSString *stringArgument(napi_env env, napi_value value) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return nil;
    std::string bytes(length + 1, '\0');
    if (napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length) != napi_ok) return nil;
    return [[NSString alloc] initWithBytes:bytes.data() length:length encoding:NSUTF8StringEncoding];
}

static void finish(napi_env env, napi_value callback, void *, void *data) {
    std::unique_ptr<Result> result(static_cast<Result *>(data));
    if (!env || !callback) return;
    napi_value args[2], receiver;
    napi_get_null(env, &args[0]);
    napi_get_null(env, &args[1]);
    if (!result->error.empty()) napi_create_string_utf8(env, result->error.data(), result->error.size(), &args[0]);
    else napi_create_string_utf8(env, result->json.data(), result->json.size(), &args[1]);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 2, args, nullptr);
}

static napi_value invoke(napi_env env, napi_callback_info info) {
    @autoreleasepool {
        size_t argc = 3;
        napi_value args[3], resource;
        napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
        if (argc != 3) { napi_throw_type_error(env, nullptr, "Expected a notification request and callback."); return nullptr; }
        NSString *operation = stringArgument(env, args[0]);
        NSString *json = stringArgument(env, args[1]);
        id payload = json ? [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding]
                                                          options:NSJSONReadingFragmentsAllowed error:nil] : nil;
        if (!operation || !payload) { napi_throw_type_error(env, nullptr, "Invalid notification request."); return nullptr; }
        napi_threadsafe_function channel;
        napi_create_string_utf8(env, "Mac notification center", NAPI_AUTO_LENGTH, &resource);
        if (napi_create_threadsafe_function(env, args[2], nullptr, resource, 1, 1, nullptr, nullptr, nullptr, finish, &channel) != napi_ok) {
            napi_throw_error(env, nullptr, "Could not initialize the notification callback."); return nullptr;
        }
        Reply reply = ^(id value, NSString *error) {
            NSError *encodingError;
            NSData *bytes = value ? [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:&encodingError] : nil;
            Result *result = new Result;
            if (error || !bytes) result->error = (error ?: encodingError.localizedDescription ?: @"Invalid notification result.").UTF8String;
            else result->json.assign(static_cast<const char *>(bytes.bytes), bytes.length);
            if (napi_call_threadsafe_function(channel, result, napi_tsfn_nonblocking) != napi_ok) delete result;
            napi_release_threadsafe_function(channel, napi_tsfn_release);
        };
        @try {
            BOOL bundled = [NSBundle.mainBundle.bundleURL.pathExtension isEqualToString:@"app"] && NSBundle.mainBundle.bundleIdentifier.length;
            perform(bundled ? UNUserNotificationCenter.currentNotificationCenter : nil, operation, payload, reply);
        }
        @catch (NSException *exception) { reply(nil, exception.reason ?: @"macOS could not complete the notification request."); }
        napi_value undefined;
        napi_get_undefined(env, &undefined);
        return undefined;
    }
}

NAPI_MODULE_INIT() {
    napi_value function;
    napi_create_function(env, "macNotifications", NAPI_AUTO_LENGTH, invoke, nullptr, &function);
    return function;
}
#endif
