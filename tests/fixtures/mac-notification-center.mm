#define MAC_NOTIFICATION_TESTS
#import "../../native/MacNotifications.mm"

@interface TestSettings : NSObject
@property UNAuthorizationStatus authorizationStatus;
@end
@implementation TestSettings
@end

@interface TestCenter : NSObject
@property(nonatomic, weak) id<UNUserNotificationCenterDelegate> delegate;
@property(nonatomic, strong) NSMutableDictionary<NSString *, UNNotificationRequest *> *requests;
@property(nonatomic, strong) TestSettings *settings;
@property NSInteger prompts;
@end
@implementation TestCenter
- (void)getNotificationSettingsWithCompletionHandler:(void (^)(UNNotificationSettings *))completion {
    completion((UNNotificationSettings *)self.settings);
}
- (void)requestAuthorizationWithOptions:(UNAuthorizationOptions)options completionHandler:(void (^)(BOOL, NSError *))completion {
    NSCAssert(options == (UNAuthorizationOptionAlert | UNAuthorizationOptionSound), @"Unexpected authorization options");
    self.prompts++;
    self.settings.authorizationStatus = UNAuthorizationStatusAuthorized;
    completion(YES, nil);
}
- (void)getPendingNotificationRequestsWithCompletionHandler:(void (^)(NSArray *))completion {
    completion(self.requests.allValues);
}
- (void)getDeliveredNotificationsWithCompletionHandler:(void (^)(NSArray *))completion {
    completion(@[]);
}
- (void)addNotificationRequest:(UNNotificationRequest *)request withCompletionHandler:(void (^)(NSError *))completion {
    self.requests[request.identifier] = request;
    completion(nil);
}
- (void)removePendingNotificationRequestsWithIdentifiers:(NSArray *)identifiers {
    [self.requests removeObjectsForKeys:identifiers];
}
@end

static id run(TestCenter *center, NSString *operation, id payload = nil) {
    __block id result;
    perform((UNUserNotificationCenter *)center, operation, payload, ^(id value, NSString *error) {
        NSCAssert(!error, @"%@", error);
        result = value;
    });
    NSCAssert(result, @"Missing response");
    return result;
}

int main() {
    @autoreleasepool {
        TestCenter *center = [TestCenter new];
        center.requests = [NSMutableDictionary dictionary];
        center.settings = [TestSettings new];
        NSCAssert([run(center, @"authorization") isEqual:@"undetermined"] && !center.prompts, @"Status must be silent");
        NSCAssert([run(center, @"requestAuthorization") isEqual:@"allowed"] && center.prompts == 1, @"Explicit authorization");
        UNMutableNotificationContent *foreign = [UNMutableNotificationContent new];
        center.requests[@"other-kind"] = [UNNotificationRequest requestWithIdentifier:@"other-kind" content:foreign trigger:nil];
        NSTimeInterval second = ceil(NSDate.date.timeIntervalSince1970) + 3600;
        NSDictionary *reminder = @{@"id": @"sample", @"title": @"Team meeting", @"body": @"Sample calendar",
                                   @"seconds": @(second), @"signature": @"version"};
        [NSTimeZone setDefaultTimeZone:[NSTimeZone timeZoneWithName:@"Europe/Berlin"]];
        run(center, @"schedule", reminder);
        UNNotificationRequest *request = center.requests[@"calendar-central.reminder.sample"];
        NSCAssert([request.content.title isEqual:@"Team meeting"] && [request.content.body isEqual:@"Sample calendar"], @"Reminder text");
        NSCAssert(request.content.sound && [request.content.userInfo[signatureKey] isEqual:@"version"], @"Sound and identity");
        UNCalendarNotificationTrigger *trigger = (UNCalendarNotificationTrigger *)request.trigger;
        NSCAssert(!trigger.repeats && trigger.dateComponents.timeZone.secondsFromGMT == 0, @"Absolute, non-repeating trigger");
        NSCAssert(fabs(trigger.nextTriggerDate.timeIntervalSince1970 - second) < 1, @"The trigger must match the source instant");
        [NSTimeZone setDefaultTimeZone:[NSTimeZone timeZoneWithName:@"America/Los_Angeles"]];
        NSCAssert(fabs(trigger.nextTriggerDate.timeIntervalSince1970 - second) < 1, @"Time zone changes must preserve the instant");
        NSDictionary *snapshot = run(center, @"snapshot");
        NSCAssert([snapshot[@"otherPending"] integerValue] == 1 && [snapshot[@"pending"][0][@"id"] isEqual:@"sample"], @"Owned schedules");
        run(center, @"cancel", @[@"sample", @"other-kind"]);
        NSCAssert(center.requests.count == 1 && center.requests[@"other-kind"], @"Mute must preserve unrelated requests");
    }
    return 0;
}
