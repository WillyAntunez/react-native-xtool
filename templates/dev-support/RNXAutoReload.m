// rn-xtool copies this file into ios-xtool/Sources/RNXtoolDevSupport on every build; edit it in rn-xtool's
// templates/dev-support.
//
// Reloads the app once when React Native could not load the JS bundle and Metro then becomes reachable. On the
// first launch iOS denies React Native's request to Metro while the Local Network prompt is open (Apple TN3179), and
// an app opened before `rn-xtool start` finds no Metro: both end on the red screen "No script URL provided". When
// Local Network access stays denied, it shows one alert that leads to Settings. The decisions live in
// RNXAutoReloadPolicy.c; this file connects them to React Native, UIKit and Network.framework.
//
// Only public React Native names, looked up at run time: if React Native renames one, this does nothing and the app
// behaves as before. rn-xtool generates this target only for Debug builds without expo-dev-client.
#if DEBUG
#import <Foundation/Foundation.h>
#import <Network/Network.h>
#import <UIKit/UIKit.h>
#include <dlfcn.h>
#include "RNXtoolDevSupport.h"

// React/Base/RCTConstants.h and RCTReloadCommand.h. React Native 0.86 posts RCTInstanceDidLoadBundle (a literal,
// not a public constant) but not RCTJavaScriptDidLoadNotification in the new architecture; if it is ever renamed,
// the worst case is one extra reload after a manual Reload. tests/devSupport.test.ts checks each name against the
// pinned React Native releases.
static NSString *const RNXBundleFailed = @"RCTJavaScriptDidFailToLoadNotification";
static NSString *const RNXBundleLoaded = @"RCTJavaScriptDidLoadNotification";
static NSString *const RNXInstanceLoaded = @"RCTInstanceDidLoadBundle";
static const char *const RNXReloadSymbol = "RCTTriggerReloadCommandListeners";

static NSString *const RNXAlertTitle = @"Local Network access is off";
static NSString *const RNXAlertMessage =
    @"This debug build loads its JavaScript from Metro on your computer, which needs Local Network access. Turn it "
    @"on for this app in Settings (Privacy & Security → Local Network), then come back. If the red screen stays, "
    @"tap Reload.";

typedef void (*RNXReloadFunction)(NSString *reason);

static void RNXOnMain(dispatch_block_t block) {
  if (NSThread.isMainThread) block();
  else dispatch_async(dispatch_get_main_queue(), block);
}

@interface RNXAutoReload : NSObject
@end

@implementation RNXAutoReload {
  rnx_state _state;  // like everything below, used on the main queue only
  nw_connection_t _connection;
  NSString *_host;
  NSString *_port;
}

+ (void)load {
  static RNXAutoReload *shared;
  shared = [RNXAutoReload new];
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserver:shared selector:@selector(bundleFailed) name:RNXBundleFailed object:nil];
  [center addObserver:shared selector:@selector(bundleLoaded) name:RNXBundleLoaded object:nil];
  [center addObserver:shared selector:@selector(bundleLoaded) name:RNXInstanceLoaded object:nil];
  [center addObserver:shared selector:@selector(foreground) name:UIApplicationDidBecomeActiveNotification object:nil];
  [center addObserver:shared selector:@selector(resignActive) name:UIApplicationWillResignActiveNotification object:nil];
  [center addObserver:shared selector:@selector(background) name:UIApplicationDidEnterBackgroundNotification object:nil];
}

- (instancetype)init {
  if ((self = [super init])) rnx_init(&_state);
  return self;
}

- (void)bundleFailed {
  RNXOnMain(^{
    if (self->_host == nil && ![self readMetroAddress]) return;
    if (dlsym(RTLD_DEFAULT, RNXReloadSymbol) == NULL) {
      NSLog(@"[rn-xtool] %s not found: the app will not reload by itself once Metro is reachable", RNXReloadSymbol);
      return;
    }
    self->_state.foreground = UIApplication.sharedApplication.applicationState != UIApplicationStateBackground;
    [self step:RNX_EVENT_BUNDLE_FAILED];
  });
}
- (void)bundleLoaded { RNXOnMain(^{ [self step:RNX_EVENT_BUNDLE_LOADED]; }); }
- (void)foreground { RNXOnMain(^{ [self step:RNX_EVENT_FOREGROUND]; }); }
- (void)resignActive { RNXOnMain(^{ [self step:RNX_EVENT_RESIGN_ACTIVE]; }); }
- (void)background { RNXOnMain(^{ [self step:RNX_EVENT_BACKGROUND]; }); }

- (void)step:(rnx_event)event {
  double now = NSProcessInfo.processInfo.systemUptime;
  switch (rnx_step(&_state, event, now)) {
    case RNX_ACTION_NONE: {
      break;
    }
    case RNX_ACTION_CONNECT: {
      [self connect];
      break;
    }
    case RNX_ACTION_RETRY_LATER: {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(RNX_RETRY_SECONDS * NSEC_PER_SEC)),
                     dispatch_get_main_queue(), ^{ [self step:RNX_EVENT_RETRY_DUE]; });
      break;
    }
    case RNX_ACTION_DISCONNECT:
    case RNX_ACTION_STOP: {
      [self disconnect];
      break;
    }
    case RNX_ACTION_RELOAD: {
      [self disconnect];
      RNXReloadFunction reload = (RNXReloadFunction)dlsym(RTLD_DEFAULT, RNXReloadSymbol);
      if (reload != NULL) reload(@"rn-xtool: Metro is reachable");
      break;
    }
  }
  if (rnx_should_alert(&_state, now) && [self showLocalNetworkAlert]) rnx_alert_shown(&_state);
}

// The address React Native uses. Bare apps carry host:port in ip.txt. Expo apps carry the host in ip.txt and the
// port in Info.plist's RCTMetroPort, which ExpoReactNativeFactory turns into RCTBundleURLProvider's jsLocation.
- (BOOL)readMetroAddress {
  NSString *file = [NSBundle.mainBundle pathForResource:@"ip" ofType:@"txt"];
  NSString *text = file ? [NSString stringWithContentsOfFile:file encoding:NSUTF8StringEncoding error:NULL] : nil;
  text = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (text.length == 0) return NO;
  NSRange colon = [text rangeOfString:@":" options:NSBackwardsSearch];
  id port;
  if (colon.location != NSNotFound) {
    _host = [text substringToIndex:colon.location];
    port = [text substringFromIndex:NSMaxRange(colon)];
  } else {
    _host = text;
    port = [NSBundle.mainBundle objectForInfoDictionaryKey:@"RCTMetroPort"];
    if ([port isKindOfClass:NSNumber.class]) port = [port stringValue];
  }
  _port = [port isKindOfClass:NSString.class] && [port length] > 0 ? port : @"8081";
  return _host.length > 0;
}

- (void)connect {
  [self disconnect];
  nw_endpoint_t endpoint = nw_endpoint_create_host(_host.UTF8String, _port.UTF8String);
  nw_parameters_t parameters =
      nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
  nw_connection_t connection = nw_connection_create(endpoint, parameters);
  _connection = connection;
  nw_connection_set_queue(connection, dispatch_get_main_queue());
  __weak nw_connection_t weakConnection = connection;
  nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t state, __unused nw_error_t error) {
    nw_connection_t current = weakConnection;
    if (current == nil || current != self->_connection) return;  // replaced or cancelled
    if (state == nw_connection_state_ready) {
      [self step:RNX_EVENT_METRO_READY];
    } else if (state == nw_connection_state_waiting || state == nw_connection_state_failed) {
      nw_path_t path = nw_connection_copy_current_path(current);
      BOOL denied = path != nil &&
                    nw_path_get_unsatisfied_reason(path) == nw_path_unsatisfied_reason_local_network_denied;
      [self step:denied ? RNX_EVENT_LOCAL_NETWORK_DENIED : RNX_EVENT_METRO_UNREACHABLE];
    }
  });
  nw_connection_start(connection);
}

- (void)disconnect {
  if (_connection == nil) return;
  nw_connection_t connection = _connection;
  _connection = nil;
  nw_connection_cancel(connection);
}

// Presented from the topmost view controller: the red box is itself presented over the key window's root. Returns
// whether the alert is on screen. UIKit refuses it without a foreground key window, while a view controller is being
// presented or dismissed, or over another alert; the policy then tries again on a later step.
- (BOOL)showLocalNetworkAlert {
  UIViewController *top = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (scene.activationState != UISceneActivationStateForegroundActive) continue;
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    top = ((UIWindowScene *)scene).keyWindow.rootViewController;
    break;
  }
  while (top.presentedViewController != nil) top = top.presentedViewController;
  if (top == nil || top.isBeingPresented || top.isBeingDismissed) return NO;
  if ([top isKindOfClass:UIAlertController.class]) return [top.title isEqualToString:RNXAlertTitle];
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:RNXAlertTitle
                                                                 message:RNXAlertMessage
                                                          preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"Open Settings"
                                            style:UIAlertActionStyleDefault
                                          handler:^(__unused UIAlertAction *action) {
                                            NSURL *settings = [NSURL URLWithString:UIApplicationOpenSettingsURLString];
                                            if (settings != nil) {
                                              [UIApplication.sharedApplication openURL:settings
                                                                               options:@{}
                                                                     completionHandler:nil];
                                            }
                                          }]];
  [alert addAction:[UIAlertAction actionWithTitle:@"Not Now" style:UIAlertActionStyleCancel handler:nil]];
  [top presentViewController:alert animated:YES completion:nil];
  return alert.presentingViewController != nil;
}

@end
#endif
