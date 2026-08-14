#import <AppKit/AppKit.h>
#import <QuickLookUI/QuickLookUI.h>

static NSString* const SummaryFile = @"OverlookSummary.json";
static NSUInteger const SummaryLimit = 4096;

static NSError* Unavailable(void) {
  return [NSError errorWithDomain:@"com.zts1.overlook.quick-look" code:1 userInfo:nil];
}

@interface PreviewViewController : NSViewController <QLPreviewingController>
@end

@implementation PreviewViewController
- (void)loadView {
  self.view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 520, 300)];
}

- (void)preparePreviewOfFileAtURL:(NSURL*)url completionHandler:(void (^)(NSError*))completionHandler {
  NSURL* summaryURL = [url URLByAppendingPathComponent:SummaryFile isDirectory:NO];
  NSData* data = [NSData dataWithContentsOfURL:summaryURL options:NSDataReadingMappedIfSafe error:nil];
  if (data == nil || data.length > SummaryLimit) {
    completionHandler(Unavailable());
    return;
  }
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  NSString* name = [value isKindOfClass:NSDictionary.class] ? value[@"name"] : nil;
  NSNumber* count = [value isKindOfClass:NSDictionary.class] ? value[@"itemCount"] : nil;
  NSString* updated = [value isKindOfClass:NSDictionary.class] ? value[@"updatedAt"] : nil;
  NSNumber* version = [value isKindOfClass:NSDictionary.class] ? value[@"version"] : nil;
  if (![name isKindOfClass:NSString.class] || name.length == 0 || ![count isKindOfClass:NSNumber.class] ||
      count.longLongValue < 0 || ![updated isKindOfClass:NSString.class] ||
      ![version isKindOfClass:NSNumber.class] || version.integerValue != 1) {
    completionHandler(Unavailable());
    return;
  }

  NSTextField* title = [NSTextField labelWithString:name];
  title.font = [NSFont systemFontOfSize:28 weight:NSFontWeightSemibold];
  NSTextField* items = [NSTextField labelWithString:[NSString stringWithFormat:@"%@ items", count]];
  items.font = [NSFont systemFontOfSize:16];
  NSTextField* timestamp = [NSTextField labelWithString:[@"Updated " stringByAppendingString:updated]];
  timestamp.font = [NSFont systemFontOfSize:12];
  timestamp.textColor = NSColor.secondaryLabelColor;
  NSStackView* stack = [NSStackView stackViewWithViews:@[title, items, timestamp]];
  stack.orientation = NSUserInterfaceLayoutOrientationVertical;
  stack.alignment = NSLayoutAttributeLeading;
  stack.spacing = 12;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:40],
    [stack.trailingAnchor constraintLessThanOrEqualToAnchor:self.view.trailingAnchor constant:-40],
    [stack.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
  ]];
  completionHandler(nil);
}
@end
