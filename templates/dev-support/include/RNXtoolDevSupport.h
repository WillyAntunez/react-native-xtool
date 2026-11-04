// rn-xtool copies this file into ios-xtool/Sources/RNXtoolDevSupport on every build; edit it in rn-xtool's
// templates/dev-support. The public header of the RNXtoolDevSupport target: the auto-reload policy.
#pragma once
#include <stdbool.h>

#define RNX_GIVE_UP_SECONDS 300.0
#define RNX_RETRY_SECONDS 2.0
#define RNX_ALERT_AFTER_SECONDS 3.0

/// What happened, as RNXAutoReload.m reports it.
typedef enum {
  RNX_EVENT_BUNDLE_FAILED,         // RCTJavaScriptDidFailToLoadNotification
  RNX_EVENT_BUNDLE_LOADED,         // RCTJavaScriptDidLoadNotification or RCTInstanceDidLoadBundle
  RNX_EVENT_METRO_READY,           // the TCP connection to Metro's host and port is ready
  RNX_EVENT_METRO_UNREACHABLE,     // the connection waits or failed for another reason (Metro down, wrong IP)
  RNX_EVENT_LOCAL_NETWORK_DENIED,  // the connection waits because Local Network access is denied
  RNX_EVENT_RETRY_DUE,             // RNX_RETRY_SECONDS passed after RNX_ACTION_RETRY_LATER
  RNX_EVENT_FOREGROUND,            // UIApplicationDidBecomeActiveNotification
  RNX_EVENT_RESIGN_ACTIVE,         // UIApplicationWillResignActiveNotification (a system prompt, the app switcher)
  RNX_EVENT_BACKGROUND,            // UIApplicationDidEnterBackgroundNotification
} rnx_event;

/// What RNXAutoReload.m does next.
typedef enum {
  RNX_ACTION_NONE,
  RNX_ACTION_CONNECT,      // open a new connection to Metro (closing any other)
  RNX_ACTION_RETRY_LATER,  // send RNX_EVENT_RETRY_DUE in RNX_RETRY_SECONDS
  RNX_ACTION_DISCONNECT,   // close the connection; the failure stays pending
  RNX_ACTION_RELOAD,       // close the connection and reload once
  RNX_ACTION_STOP,         // close the connection and give up on this failure
} rnx_action;

typedef struct {
  bool loaded;              // a bundle loaded: never reload again in this process
  bool pending;             // a load failure waits for Metro
  bool connecting;          // a connection to Metro is open
  bool saw_unreachable;     // Metro was out of reach at some point since that failure
  bool retry_scheduled;     // an RNX_EVENT_RETRY_DUE is on its way
  bool foreground;          // the app is not in the background; set before RNX_EVENT_BUNDLE_FAILED
  bool active;              // the app is active: no system prompt over it
  bool alerted;             // the Local Network alert was shown in this process
  double first_failure_at;  // seconds; below 0 until the first failure
  double active_since;      // when the app last became active; below 0 before
  double denied_since;      // first denied report of the current denied streak; below 0 when not denied
} rnx_state;

void rnx_init(rnx_state *state);
rnx_action rnx_step(rnx_state *state, rnx_event event, double now);
/// True when Local Network access has been denied for RNX_ALERT_AFTER_SECONDS while the app was active, a load failure
/// is pending, the 5 minutes have not passed and the alert has not been shown in this process.
bool rnx_should_alert(const rnx_state *state, double now);
/// The alert is on screen: rnx_should_alert stays false for the rest of the process. Not called when UIKit refused to
/// present it, so a later step can try again.
void rnx_alert_shown(rnx_state *state);
